#!/usr/bin/env node
// 渲染器浏览器验证 harness（ADR-0005 §8；技术设计 §10）。
//
// 零 npm 依赖方案说明：不引入 puppeteer / chrome-remote-interface / package.json，
// 直接 spawn 系统 Chrome（--headless=new --remote-debugging-port=0），用 Node ≥22
// 内置的全局 WebSocket 直连 DevTools 端口，自写最小 CDP 客户端（仅
// enable / addScriptToEvaluateOnNewDocument / navigate / evaluate 四类调用）。
//
// 模式：
//   node scripts/validate-renderer.mjs           完整浏览器断言（不读写证明）
//   node scripts/validate-renderer.mjs --check   证明继承检查（七键相等；不起浏览器）
//   node scripts/validate-renderer.mjs --write   浏览器断言通过后签发证明文件
//
// Chrome 路径：CHROME_PATH 环境变量优先，其次探测 macOS 应用路径与
// Linux 常见命令名。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(
  REPO_ROOT, "plugins", "voidtech-core", "skills", "prd-from-requirements");
const PROOF_PATH = path.join(SKILL_ROOT, "assets", "renderer-validation-proof.json");

// 与 atlas._PROOF_INHERIT_KEYS 同序；比较语义等价于 atlas.proof_inherits
// （键存在、非空且相等）。
const INHERIT_KEYS = [
  "rendererVersion", "generatorVersion", "schemaVersion", "assetDigest",
  "fixtureDigest", "validationHarnessVersion", "browserMatrixVersion",
];

// ---------------------------------------------------------------- 引擎侧输入

function loadRendererFixture() {
  const code = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from prdsync import atlas",
    "print(json.dumps({",
    "    'env': atlas.renderer_env(),",
    "    'html': atlas.render_fixture_html(),",
    "    'markers': {'home': atlas._FIXTURE_HOME_TITLE,",
    "                'probe': atlas._FIXTURE_PROBE_TITLE},",
    "}, ensure_ascii=False))",
  ].join("\n");
  const out = spawnSync("python3", ["-c", code, path.join(SKILL_ROOT, "scripts")],
    { encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`python3 调用 atlas.renderer_env 失败:\n${out.stderr}`);
  }
  return JSON.parse(out.stdout);
}

// ---------------------------------------------------------------- Chrome 探测

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const fixed = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const candidate of fixed) if (existsSync(candidate)) return candidate;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
    const which = spawnSync("which", [name], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  throw new Error("未找到 Chrome/Chromium，请设置 CHROME_PATH 指向可用二进制");
}

// ---------------------------------------------------------------- 最小 CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.eventListeners = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of this.eventListeners) listener(msg);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(listener) {
    this.eventListeners.push(listener);
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待 ${method} 超时（${timeoutMs}ms）`)), timeoutMs);
      this.onEvent((msg) => {
        if (msg.method === method) {
          clearTimeout(timer);
          resolve(msg.params);
        }
      });
    });
  }
}

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败: ${url}`)));
  });
}

async function waitForDevtoolsPort(chrome) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`Chrome DevTools 端口未就绪:\n${stderr}`)), 20000);
    chrome.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    chrome.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 提前退出（exit ${code}）:\n${stderr}`));
    });
  });
}

async function findPageTarget(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const page = targets.find((t) => t.type === "page");
    if (page) return page.webSocketDebuggerUrl;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("未找到 Chrome page target");
}

// ---------------------------------------------------------------- 浏览器断言

async function runBrowserAssertions(fixture) {
  const chromePath = findChrome();
  const workDir = mkdtempSync(path.join(tmpdir(), "renderer-validation-"));
  const htmlPath = path.join(workDir, "logic-atlas-fixture.html");
  writeFileSync(htmlPath, fixture.html, "utf8");
  const docUrl = pathToFileURL(htmlPath).href;

  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${path.join(workDir, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const consoleErrors = [];
  const externalRequests = [];
  try {
    const port = await waitForDevtoolsPort(chrome);
    const ws = await connectWebSocket(await findPageTarget(port));
    const cdp = new Cdp(ws);
    cdp.onEvent((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(`pageerror: ${JSON.stringify(msg.params.exceptionDetails)}`);
      } else if (msg.method === "Runtime.consoleAPICalled"
          && (msg.params.type === "error" || msg.params.type === "assert")) {
        consoleErrors.push(`console.${msg.params.type}: ${JSON.stringify(msg.params.args)}`);
      } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        consoleErrors.push(`log: ${msg.params.entry.text}`);
      } else if (msg.method === "Network.requestWillBeSent") {
        // 文档自身导航之外的任何请求都表示外链未内联，违反自包含契约。
        const url = msg.params.request.url;
        if (url !== docUrl && !url.startsWith("data:")) externalRequests.push(url);
      }
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    // alert 探针：任何未转义脚本触发的对话框都会被计数而不是阻塞 headless。
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__alertCount = 0;" +
        "for (const fn of ['alert', 'confirm', 'prompt']) {" +
        "  window[fn] = () => { window.__alertCount += 1; return false; };" +
        "}",
    });

    const loaded = cdp.waitForEvent("Page.loadEventFired", 20000);
    await cdp.send("Page.navigate", { url: docUrl });
    await loaded;

    const probe = JSON.stringify(fixture.markers.probe);
    // 交互探针：在搜索框输入 XSS 探针标题，viewer 应把它作为纯文本结果呈现
    // （既证明搜索框可输入，又证明 <script> 未被当作 HTML 解析/执行）。
    const expression = `(function(){
      var out = { alertCount: window.__alertCount };
      out.scriptSrcCount = document.querySelectorAll("script[src]").length;
      var modelEl = document.getElementById("atlas-model");
      out.hasModelTag = !!modelEl;
      try { JSON.parse(modelEl.textContent); out.modelParses = true; }
      catch (e) { out.modelParses = false; }
      out.hasSearch = !!document.getElementById("search");
      out.hasThemeBtn = !!document.getElementById("themeBtn");
      var app = document.querySelector(".app");
      out.mainTextLen = app ? app.innerText.trim().length : 0;
      out.sidebarChildren = (document.getElementById("mods") || {}).childElementCount || 0;
      out.behaviorViews = {};
      var flowPanel = document.getElementById("view-flow");
      out.scenarioFlow = {
        defaultVisible: !!flowPanel && !flowPanel.hidden,
        selector: !!document.getElementById("scenario-picker"),
        groups: flowPanel ? flowPanel.querySelectorAll(".scenario-group").length : 0,
        steps: flowPanel ? flowPanel.querySelectorAll(".flow-step-wrap").length : 0,
        impacts: flowPanel ? flowPanel.querySelectorAll(".state-impact-chip").length : 0,
        exceptionGroups: flowPanel ? flowPanel.querySelectorAll(".step-exceptions").length : 0,
        dependencyLanes: flowPanel ? flowPanel.querySelectorAll(".scenario-lane").length - 1 : 0,
        boundaryDisclosures: flowPanel ? flowPanel.querySelectorAll(".scenario-details").length : 0
      };
      ["flow", "state", "boundary"].forEach(function(name){
        var tab = document.getElementById("tab-" + name);
        var panel = document.getElementById("view-" + name);
        if (tab) tab.click();
        out.behaviorViews[name] = {
          tab: !!tab,
          visible: !!panel && !panel.hidden,
          text: panel ? panel.innerText.trim().length : 0,
          interactive: panel ? panel.querySelectorAll("button").length : 0
        };
      });
      var probe = ${probe};
      var search = document.getElementById("search");
      out.searchTypable = false;
      out.probeVisibleAsText = false;
      if (search) {
        search.focus();
        search.value = probe;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        out.searchTypable = (search.value === probe);
        var results = document.getElementById("results");
        out.probeVisibleAsText =
          !!results && !results.hidden && results.textContent.indexOf(probe) >= 0;
      }
      return JSON.stringify(out);
    })()`;
    const evaluated = await cdp.send("Runtime.evaluate",
      { expression, returnByValue: true });
    if (evaluated.exceptionDetails) {
      throw new Error(`断言表达式执行失败: ${JSON.stringify(evaluated.exceptionDetails)}`);
    }
    const dom = JSON.parse(evaluated.result.value);

    const failures = [];
    if (consoleErrors.length > 0) failures.push(`存在 console/page 错误: ${consoleErrors.join("; ")}`);
    if (dom.alertCount !== 0) failures.push(`alert/confirm/prompt 探针被触发 ${dom.alertCount} 次（存在未转义脚本执行）`);
    if (dom.scriptSrcCount !== 0) failures.push(`存在 ${dom.scriptSrcCount} 个外链 script[src]（脚本必须全部内联）`);
    if (externalRequests.length > 0) failures.push(`页面加载期间存在文档自身以外的网络请求: ${externalRequests.join(", ")}`);
    if (!dom.hasModelTag) failures.push("缺少 #atlas-model 注入标签");
    if (!dom.modelParses) failures.push("#atlas-model 标签内容无法 JSON.parse");
    if (dom.mainTextLen === 0) failures.push("应用主区渲染为空");
    if (dom.sidebarChildren === 0) failures.push("模块导航未渲染任何条目");
    if (!dom.hasSearch) failures.push("搜索框 #search 缺失");
    if (!dom.hasThemeBtn) failures.push("主题切换按钮 #themeBtn 缺失");
    if (!dom.searchTypable) failures.push("搜索框无法输入（value 未按写入生效）");
    if (!dom.probeVisibleAsText) failures.push("XSS 探针标题未以纯文本形式在搜索结果中呈现");
    for (const [name, result] of Object.entries(dom.behaviorViews ?? {})) {
      if (!result.tab || !result.visible || result.text === 0 || result.interactive === 0) {
        failures.push(`行为视图 ${name} 未完成可见且可交互渲染: ${JSON.stringify(result)}`);
      }
    }
    if (Object.keys(dom.behaviorViews ?? {}).length !== 3) {
      failures.push("行为视图断言未覆盖 flow/state/boundary 三个 tab");
    }
    const scenario = dom.scenarioFlow ?? {};
    if (!scenario.defaultVisible) failures.push("场景流程不是默认可见入口");
    if (scenario.groups < 1 || scenario.steps < 2) {
      failures.push(`场景流程主干未渲染完整: ${JSON.stringify(scenario)}`);
    }
    if (!scenario.selector) failures.push("场景流程缺少业务场景选择器");
    if (scenario.impacts < 1) failures.push("场景步骤未嵌入业务状态变化");
    if (scenario.exceptionGroups < 1) failures.push("场景步骤未嵌入可展开异常");
    if (scenario.dependencyLanes < 1) failures.push("场景流程未渲染跨模块/外部依赖泳道");
    if (scenario.boundaryDisclosures < 1) failures.push("场景流程未集成模块职责边界");
    if (failures.length > 0) {
      throw new Error(`浏览器断言失败:\n- ${failures.join("\n- ")}`);
    }

    console.log("浏览器断言全部通过:");
    console.log(`- console/page 错误: 0`);
    console.log(`- alert/confirm/prompt 探针触发次数: ${dom.alertCount}`);
    console.log(`- 外链 script[src] 数: ${dom.scriptSrcCount}`);
    console.log(`- 文档外网络请求数: ${externalRequests.length}`);
    console.log(`- #atlas-model 可 JSON.parse: ${dom.modelParses}`);
    console.log(`- 应用主区文本长度: ${dom.mainTextLen}（模块导航 ${dom.sidebarChildren} 项）`);
    console.log(`- 搜索框存在且可输入: ${dom.hasSearch}/${dom.searchTypable}；主题切换按钮: ${dom.hasThemeBtn}`);
    console.log(`- XSS 探针以纯文本可见: ${dom.probeVisibleAsText}`);
    console.log(`- 行为视图可见且可交互: ${JSON.stringify(dom.behaviorViews)}`);
    console.log(`- 场景流程默认入口及四层信息: ${JSON.stringify(dom.scenarioFlow)}`);
    ws.close();
  } finally {
    if (chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill("SIGKILL");
      await exited;
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 证明读写

function checkProofInherits(env) {
  if (!existsSync(PROOF_PATH)) {
    console.error(`证明文件不存在: ${path.relative(REPO_ROOT, PROOF_PATH)}`);
    console.error("请本地运行 node scripts/validate-renderer.mjs --write 后提交证明。");
    return false;
  }
  const proof = JSON.parse(readFileSync(PROOF_PATH, "utf8"));
  const stale = INHERIT_KEYS.filter(
    (key) => !proof[key] || !env[key] || proof[key] !== env[key]);
  if (stale.length > 0) {
    console.error(`渲染器验证证明不继承，以下键与当前环境不一致: ${stale.join(", ")}`);
    console.error("渲染器/fixture/harness 已变化，需重新浏览器验证:");
    console.error("请本地运行 node scripts/validate-renderer.mjs --write 后提交证明。");
    return false;
  }
  console.log("渲染器验证证明继承成立（七个继承键全部一致），无需重新打开浏览器。");
  return true;
}

function writeProof(env) {
  const proof = {};
  for (const key of INHERIT_KEYS) proof[key] = env[key];
  proof.browserValidated = true;
  proof.validatedAt = new Date().toISOString();
  mkdirSync(path.dirname(PROOF_PATH), { recursive: true });
  writeFileSync(PROOF_PATH, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  console.log(`已签发渲染器验证证明: ${path.relative(REPO_ROOT, PROOF_PATH)}`);
}

// ---------------------------------------------------------------- 入口

async function main() {
  const mode = process.argv[2] ?? "";
  if (mode !== "" && mode !== "--check" && mode !== "--write") {
    console.error("用法: node scripts/validate-renderer.mjs [--check|--write]");
    process.exit(2);
  }

  const fixture = loadRendererFixture();

  if (mode === "--check") {
    process.exit(checkProofInherits(fixture.env) ? 0 : 1);
  }

  await runBrowserAssertions(fixture);
  if (mode === "--write") {
    writeProof(fixture.env);
  }
}

main().catch((error) => {
  console.error(String(error.stack ?? error));
  process.exit(1);
});
