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
//   node scripts/validate-renderer.mjs --check   证明继承检查（八键相等；不起浏览器）
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
  REPO_ROOT, "plugins", "voidtech-product", "skills", "prd-from-requirements");
const PROOF_PATH = path.join(SKILL_ROOT, "assets", "renderer-validation-proof.json");

// 与 atlas._PROOF_INHERIT_KEYS 同序；比较语义等价于 atlas.proof_inherits
// （键存在、非空且相等）。
const INHERIT_KEYS = [
  "rendererVersion", "generatorVersion", "schemaVersion", "assetDigest",
  "archifyDigest", "fixtureDigest", "validationHarnessVersion",
  "browserMatrixVersion",
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
    "    'model': atlas._fixture_model(),",
    "    'fallbackHtml': atlas.render_fallback_fixture_html(),",
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
  const fallbackHtmlPath = path.join(workDir, "logic-atlas-fallback-fixture.html");
  writeFileSync(fallbackHtmlPath, fixture.fallbackHtml, "utf8");
  const fallbackUrl = pathToFileURL(fallbackHtmlPath).href;
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
        if (![docUrl, fallbackUrl].includes(url) && !url.startsWith("data:")) {
          externalRequests.push(url);
        }
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
    const expectedBranchKinds = {
      failureBranch: fixture.model.nodes.filter((node) =>
        node.kind === "flow" && node.detail?.category === "failureBranch").length,
      pageState: fixture.model.nodes.filter((node) =>
        node.kind === "state" && node.detail?.category === "pageState").length,
      failureRecovery: fixture.model.nodes.filter((node) =>
        node.kind === "flow" && node.detail?.category === "interactionStep"
        && node.detail.failureRecovery
        && !["—", "无"].includes(node.detail.failureRecovery)).length,
      stateImpact: fixture.model.nodes.filter((node) =>
        node.kind === "flow" && node.detail?.category === "stateImpact").length
    };
    const fixtureNodesById = Object.fromEntries(
      fixture.model.nodes.map((node) => [node.nodeId, node]));
    const expectedWorkflowFacts = fixture.model.edges
      .filter((edge) => {
        const from = fixtureNodesById[edge.from];
        const to = fixtureNodesById[edge.to];
        return edge.kind === "navigates" && edge.detail?.branch === "success"
          && from?.detail?.category === "flowStep"
          && to?.detail?.category === "flowStep";
      })
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId))
      .map((edge) => ({
        edgeId: edge.edgeId,
        from: fixtureNodesById[edge.from].detail.stepId,
        to: fixtureNodesById[edge.to].detail.stepId,
        condition: edge.detail.condition || ""
      }));
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
      out.pageOverflow = {
        html: getComputedStyle(document.documentElement).overflowX,
        body: getComputedStyle(document.body).overflowX,
        bodyClipped: document.body.scrollWidth > document.body.clientWidth
      };
      var explorePanel = document.getElementById("view-explore");
      out.explore = {
        defaultVisible: !!explorePanel && !explorePanel.hidden,
        taskEntries: explorePanel ? explorePanel.querySelectorAll(".explore-task").length : 0,
        statusDimensions: explorePanel ?
          explorePanel.querySelectorAll(".explore-status[data-status]").length : 0,
        emptyJourneyCopy: explorePanel ?
          explorePanel.textContent.includes("尚未声明可证明的端到端旅程") : false
      };
      var auditTab = document.getElementById("tab-audit");
      if (auditTab) auditTab.click();
      var auditPanel = document.getElementById("view-audit");
      out.audit = {
        visible: !!auditPanel && !auditPanel.hidden,
        dimensions: auditPanel ? Array.prototype.map.call(
          auditPanel.querySelectorAll(".audit-dimension[data-dimension]"),
          function(node){return node.getAttribute("data-dimension");}) : [],
        moduleRows: auditPanel ? auditPanel.querySelectorAll(".audit-module").length : 0,
        realGaps: auditPanel ? auditPanel.querySelectorAll(".audit-gap").length : 0,
        unstructuredSummary: auditPanel ?
          auditPanel.querySelectorAll(".unstructured-summary").length : 0,
        misleadingHealthLabels: auditPanel ?
          Array.prototype.filter.call(auditPanel.querySelectorAll("*"),
            function(node){return /已深化|个问题/.test(node.textContent||"");}).length : 0
      };
      var gapTab = document.getElementById("tab-gap");
      if (gapTab) gapTab.click();
      var gapPanel = document.getElementById("view-gap");
      out.gapNoise = {
        visibleItems: gapPanel ? gapPanel.querySelectorAll(".gap-item").length : 0,
        unstructuredSummary: gapPanel ?
          gapPanel.querySelectorAll(".unstructured-summary").length : 0,
        summaryText: gapPanel ?
          ((gapPanel.querySelector(".unstructured-summary") || {}).textContent || "") : ""
      };
      var gapButton = gapPanel && gapPanel.querySelector(".gap-item");
      if (gapButton) gapButton.click();
      var gapDrawer = document.getElementById("drawer");
      out.gapContext = gapDrawer ? gapDrawer.innerText : "";
      if (gapDrawer && gapDrawer.classList.contains("open")) {
        gapDrawer.querySelector(".drawer-close").click();
      }
      var flowTab = document.getElementById("tab-flow");
      if (flowTab) flowTab.click();
      out.behaviorViews = {};
      var flowPanel = document.getElementById("view-flow");
      out.scenarioFlow = {
        defaultVisible: !!flowPanel && !flowPanel.hidden,
        selector: !!document.getElementById("scenario-picker"),
        groups: flowPanel ? flowPanel.querySelectorAll(".scenario-group").length : 0,
        steps: flowPanel ? flowPanel.querySelectorAll(".flow-step-wrap").length : 0,
        roleSources: flowPanel ? flowPanel.querySelectorAll(
          ".workflow-role-source").length : 0,
        attributedRoles: flowPanel ? Array.prototype.every.call(
          flowPanel.querySelectorAll(".workflow-role-source"),
          function(source){return source.title.includes("prd.md");}) : false,
        selectedSteps: flowPanel ? flowPanel.querySelectorAll('.flow-node[aria-pressed="true"]').length : 0,
        interactionPanels: flowPanel ? flowPanel.querySelectorAll(".interaction-panel").length : 0,
        interactions: flowPanel ? flowPanel.querySelectorAll(".interaction-card").length : 0,
        attachments: flowPanel ? flowPanel.querySelectorAll(".interaction-attachments button").length : 0,
        failureDisclosures: flowPanel ? flowPanel.querySelectorAll(".interaction-attachments details").length : 0,
        dependencyLanes: flowPanel ? flowPanel.querySelectorAll(".scenario-lane").length - 1 : 0,
        boundaryDisclosures: flowPanel ? flowPanel.querySelectorAll(".scenario-details").length : 0,
        roleLanes: flowPanel ? flowPanel.querySelectorAll(".workflow-role-lane").length : 0,
        workflowLinks: flowPanel ? flowPanel.querySelectorAll(".workflow-link").length : 0,
        workflowLinkLabels: flowPanel ? Array.prototype.map.call(
          flowPanel.querySelectorAll(".workflow-link-label"),
          function(node){return node.textContent.trim();}) : [],
        workflowLinkFacts: flowPanel ? Array.prototype.map.call(
          flowPanel.querySelectorAll(".workflow-link"),
          function(node){return {
            edgeId: node.getAttribute("data-edge-id"),
            from: node.getAttribute("data-from-step"),
            to: node.getAttribute("data-to-step"),
            condition: node.getAttribute("data-condition")
          };}) : [],
        semanticIcons: flowPanel ? flowPanel.querySelectorAll(".semantic-icon").length : 0,
        interactionLegend: !!(flowPanel && flowPanel.querySelector(".interaction-legend")),
        interactionFieldIcons: flowPanel ? flowPanel.querySelectorAll(".interaction-card dt .semantic-icon").length : 0,
        branchDisclosures: flowPanel ?
          flowPanel.querySelectorAll("details.step-branches").length : 0,
        openBranchDisclosures: flowPanel ?
          flowPanel.querySelectorAll("details.step-branches[open]").length : 0,
      };
      out.scenarioFlow.branchKinds = {};
      ["failureBranch","pageState","failureRecovery","stateImpact"].forEach(function(kind){
        out.scenarioFlow.branchKinds[kind] = flowPanel ?
          flowPanel.querySelectorAll(
            '.branch-node[data-branch-kind="' + kind + '"]').length : 0;
      });
      var stepButtons = flowPanel ? flowPanel.querySelectorAll(".flow-node") : [];
      var beforeStep = flowPanel && flowPanel.querySelector(".interaction-head") ?
        flowPanel.querySelector(".interaction-head").textContent : "";
      var beforeAttachments = flowPanel && flowPanel.querySelector(".interaction-panel") ?
        flowPanel.querySelector(".interaction-panel").innerText : "";
      if (stepButtons.length > 1) stepButtons[1].click();
      var switchedPanel = document.getElementById("view-flow");
      var afterStep = switchedPanel && switchedPanel.querySelector(".interaction-head") ?
        switchedPanel.querySelector(".interaction-head").textContent : "";
      var afterAttachments = switchedPanel && switchedPanel.querySelector(".interaction-panel") ?
        switchedPanel.querySelector(".interaction-panel").innerText : "";
      var switchedSelected = switchedPanel ?
        switchedPanel.querySelectorAll('.flow-node[aria-pressed="true"]').length : 0;
      var switchedCards = switchedPanel ?
        switchedPanel.querySelectorAll(".interaction-card").length : 0;
      out.scenarioFlow.stepSwitch = {
        changed: !!beforeStep && !!afterStep && beforeStep !== afterStep,
        oneSelected: switchedSelected === 1,
        hasInteractions: switchedCards > 0,
        firstHasOnlyException: beforeAttachments.includes("异常与恢复")
          && !beforeAttachments.includes("状态 ·"),
        secondHasOnlyState: afterAttachments.includes("状态 ·")
          && !afterAttachments.includes("异常与恢复")
      };
      var switchedButtons = switchedPanel ? switchedPanel.querySelectorAll(".flow-node") : [];
      if (switchedButtons.length) switchedButtons[0].click();
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
        if (name === "state") {
          var lifecyclePayload = JSON.parse(
            document.getElementById("atlas-lifecycle").textContent);
          var lifecycleMachine = lifecyclePayload.machines[0];
          var lifecycleSvg = panel.querySelector(
            ".archify-lifecycle-svg > svg");
          var expectedLabels = lifecycleMachine.ir.states.map(
            function(item){return item.label;});
          var svgTexts = lifecycleSvg ? Array.prototype.map.call(
            lifecycleSvg.querySelectorAll("text"),
            function(node){return node.textContent.trim();}) : [];
          out.lifecycle = {
            legend: !!panel.querySelector(".lifecycle-legend"),
            archifySvg: !!lifecycleSvg,
            archifyMarker: lifecycleSvg ?
              lifecycleSvg.getAttribute("data-archify-diagram") : null,
            styleTag: !!document.getElementById("archify-lifecycle-style"),
            stateFill: (function(){
              if (!lifecycleSvg) return null;
              var probe = lifecycleSvg.querySelector("text.t-primary");
              return probe ? getComputedStyle(probe).fill : null;
            })(),
            expectedStates: expectedLabels.length,
            businessStates: Object.keys(
              lifecycleMachine.stateNodeIds || {}).length,
            legendBridge: lifecycleSvg ?
              lifecycleSvg.querySelectorAll("[data-legend-bridge]").length : -1,
            declaredTerminalVisible: svgTexts.indexOf("已声明终点") >= 0,
            labelsAppearOnce: expectedLabels.every(function(label){
              return svgTexts.filter(function(text){return text===label;}).length===1;
            }),
            builtInNodes: panel.querySelectorAll(".state-graph-node").length,
            traceButtons: panel.querySelectorAll(".state-trace-list button").length,
            semanticCopy: panel.innerText
          };
        }
      });
      out.knowledgeViews = {};
      ["field","access"].forEach(function(name){
        var tab = document.getElementById("tab-" + name);
        var panel = document.getElementById("view-" + name);
        if (tab) tab.click();
        var selector = panel && panel.querySelector("select");
        var targetOption = selector && Array.prototype.find.call(
          selector.options,function(option){
            return option.value && !/· 0 项$/.test(option.textContent);
          });
        if (selector && targetOption) {
          selector.value = targetOption.value;
          selector.dispatchEvent(new Event("change",{bubbles:true}));
        }
        out.knowledgeViews[name] = {
          tab: !!tab,
          visible: !!panel && !panel.hidden,
          scoped: !!selector && !!targetOption,
          cards: panel ? panel.querySelectorAll(
            name === "field" ? ".field-card" : ".access-rule").length : 0,
          text: panel ? panel.innerText : ""
        };
      });
      var graphTab = document.getElementById("tab-graph");
      if (graphTab) graphTab.click();
      var archEmbed = document.getElementById("archEmbed");
      var archSvg = archEmbed
        ? archEmbed.querySelector(".archify-architecture-svg > svg") : null;
      var archLabels = archSvg ? Array.prototype.map.call(
        archSvg.querySelectorAll("[data-edge-label]"),
        function(node){return node.getAttribute("data-edge-label");}) : [];
      var archProbeText = archSvg ? archSvg.querySelector("text.t-primary") : null;
      out.architecture = {
        marker: archSvg ? archSvg.getAttribute("data-archify-diagram") : null,
        embedVisible: !!archEmbed && !archEmbed.hidden,
        components: archSvg ? archSvg.querySelectorAll("[data-node-id]").length : 0,
        totalConnections: archLabels.length,
        labeledConnections: archLabels.filter(
          function(text){return text && text.length;}).length,
        styleTag: !!document.getElementById("archify-architecture-style"),
        fill: archProbeText ? getComputedStyle(archProbeText).fill : null,
        stageHidden: (function(){
          var stage = document.getElementById("svg");
          return stage ? getComputedStyle(stage).display === "none" : false;
        })()
      };
      // 点击嵌入的 fixture structured 组件下钻：核心「系统关系」导航必须保留。
      var drillComp = archSvg ?
        archSvg.querySelector('[data-node-id="m-01-portal__01-module"]') : null;
      if (drillComp) drillComp.dispatchEvent(new MouseEvent("click",{bubbles:true}));
      out.architecture.drilledToModule =
        document.querySelectorAll("#view-graph .n-focus").length > 0;
      var pageNode = document.querySelector("#view-graph .n-focus.page");
      if (pageNode) pageNode.dispatchEvent(new MouseEvent("click",{bubbles:true}));
      // fixture 同时覆盖一条合法页面级读取与一个尚未声明关系的页面。
      // 页面级事实必须画出；模块级契约仍在独立轨；missing 页面保留显式标记。
      out.pageDataAudit = {
        explicitGap: !!document.querySelector("#view-graph .module-data-gap"),
        pageLevelEdges: document.querySelectorAll(
          "#view-graph .edge.reads:not(.module-level)," +
          "#view-graph .edge.writes:not(.module-level)").length,
        moduleLevelEdges: document.querySelectorAll(
          "#view-graph .edge.module-level").length,
        focusedPageEdges: document.querySelectorAll(
          "#view-graph .edge.hot:not(.module-level)").length,
        unboundPageMarkers: document.querySelectorAll(
          "#view-graph .page-unbound").length,
      };
      if (reqDrawer && reqDrawer.classList.contains("open")) {
        document.querySelector(".drawer-close").click();
      }
      var reqTab = document.getElementById("tab-req");
      if (reqTab) reqTab.click();
      var reqRow = document.querySelector('#view-req tr[data-req="REQ-100"]');
      var reqSummary = reqRow ? (reqRow.querySelector(".rq-summary") || {}).textContent || "" : "";
      var reqButton = reqRow ? reqRow.querySelector(".rq-id") : null;
      if (reqButton) reqButton.click();
      var reqDrawer = document.getElementById("drawer");
      var refs = reqDrawer ? reqDrawer.querySelectorAll(".requirement-reference") : [];
      if (refs.length) refs[0].click();
      var sourceLink = reqDrawer ? reqDrawer.querySelector(".src") : null;
      var navigatedToReference =
        document.getElementById("tab-flow").getAttribute("aria-selected") === "true";
      var stateTabForDrawer = document.getElementById("tab-state");
      if (stateTabForDrawer) stateTabForDrawer.click();
      var drawerClosedOnTab =
        !!reqDrawer && !reqDrawer.classList.contains("open");
      out.traceability = {
        summary: reqSummary,
        references: refs.length,
        navigated: navigatedToReference,
        anchoredSource: !!sourceLink && sourceLink.getAttribute("href").includes("#:~:text="),
        drawerClosedOnTab: drawerClosedOnTab
      };
      var requirementSearch = document.getElementById("search");
      if (requirementSearch) {
        requirementSearch.value = "REQ-100";
        requirementSearch.dispatchEvent(new Event("input", { bubbles: true }));
        var requirementResult = document.querySelector("#results .result");
        if (requirementResult) requirementResult.click();
      }
      out.traceability.searchOpensDrawer =
        !!reqDrawer && reqDrawer.classList.contains("open")
        && reqDrawer.textContent.includes("会员可查看订单详情并完成订单");
      if (stateTabForDrawer) stateTabForDrawer.click();
      if (reqDrawer && reqDrawer.classList.contains("open")) {
        reqDrawer.querySelector(".drawer-close").click();
      }
      var home = ${JSON.stringify(fixture.markers.home)};
      var pageSearch = document.getElementById("search");
      if (pageSearch) {
        pageSearch.value = home;
        pageSearch.dispatchEvent(new Event("input", { bubbles: true }));
        var homeResult = document.querySelector("#results .result");
        if (homeResult) homeResult.click();
      }
      var pageDrawer = document.getElementById("drawer");
      out.pageContext = {
        primary: pageDrawer ?
          ((pageDrawer.querySelector(".page-primary") || {}).innerText || "") : "",
        progressiveSections: pageDrawer ?
          pageDrawer.querySelectorAll("details.page-context-section").length : 0,
        mappedData: pageDrawer ? pageDrawer.innerText.includes("读取") : false,
        provenDestination: pageDrawer ?
          pageDrawer.innerText.includes(${probe}) : false,
        moduleOnlyAccess: pageDrawer ?
          Array.prototype.some.call(
            pageDrawer.querySelectorAll("details.page-context-section summary"),
            function(summary){return summary.textContent.includes("访问边界（模块级）");})
          && !pageDrawer.querySelector(".access-rule") : false
      };
      if (pageDrawer && pageDrawer.classList.contains("open")) {
        pageDrawer.querySelector(".drawer-close").click();
      }
      if (pageSearch) {
        pageSearch.value = ${probe};
        pageSearch.dispatchEvent(new Event("input", { bubbles: true }));
        var missingPageResult = document.querySelector("#results .result");
        if (missingPageResult) missingPageResult.click();
      }
      out.pageContext.missingState = pageDrawer ?
        !!pageDrawer.querySelector('.declaration-state[data-state="missing"]') : false;
      if (pageDrawer && pageDrawer.classList.contains("open")) {
        pageDrawer.querySelector(".drawer-close").click();
      }
      out.searchCoverage = {};
      [["field","订单编号"],["access","会员 · 查看"]].forEach(function(entry){
        if (!pageSearch) return;
        pageSearch.value = entry[1];
        pageSearch.dispatchEvent(new Event("input", { bubbles: true }));
        out.searchCoverage[entry[0]] =
          !!document.querySelector("#results .result");
      });
      if (pageSearch) {
        pageSearch.value = "atlas-no-such-entry-7f4a";
        pageSearch.dispatchEvent(new Event("input", { bubbles: true }));
      }
      out.searchNoResults =
        ((document.querySelector("#results .result-empty") || {}).textContent || "");
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

    const fallbackLoaded = cdp.waitForEvent("Page.loadEventFired", 20000);
    await cdp.send("Page.navigate", { url: fallbackUrl });
    await fallbackLoaded;
    const fallbackEvaluated = await cdp.send("Runtime.evaluate", {
      expression: `(function(){
        var tab=document.getElementById("tab-state");
        if(tab) tab.click();
        var panel=document.getElementById("view-state");
        var graphTab=document.getElementById("tab-graph");
        if(graphTab) graphTab.click();
        var archEmbed=document.getElementById("archEmbed");
        return JSON.stringify({
          riskBanner: !!(panel&&panel.querySelector(".lifecycle-risk")),
          builtInNodes: panel?panel.querySelectorAll(".state-graph-node").length:0,
          archifySvgs: panel?panel.querySelectorAll(".archify-lifecycle-svg > svg").length:0,
          topRisk: !!document.querySelector(".topmeta .chip.risk"),
          archEmbedHidden: !archEmbed || archEmbed.hidden,
          archEmbedSvgs: archEmbed?archEmbed.querySelectorAll(".archify-architecture-svg > svg").length:0,
          builtInOverviewCards: document.querySelectorAll("#view-graph .n-card").length
        });
      })()`,
      returnByValue: true,
    });
    if (fallbackEvaluated.exceptionDetails) {
      throw new Error(`降级断言表达式执行失败: ${JSON.stringify(fallbackEvaluated.exceptionDetails)}`);
    }
    const fallback = JSON.parse(fallbackEvaluated.result.value);

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
    if (dom.pageOverflow?.html !== "hidden" || dom.pageOverflow?.body !== "hidden"
        || dom.pageOverflow?.bodyClipped) {
      failures.push(`页面级横向裁切未受控: ${JSON.stringify(dom.pageOverflow)}`);
    }
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
    if (!dom.explore?.defaultVisible || dom.explore.taskEntries < 3
        || dom.explore.statusDimensions < 3
        || !dom.explore.emptyJourneyCopy) {
      failures.push(`探索首页未成为诚实的默认任务入口: ${JSON.stringify(dom.explore)}`);
    }
    const auditDimensions = new Set(dom.audit?.dimensions ?? []);
    if (!dom.audit?.visible || dom.audit.moduleRows !== 2
        || !["coverage","depth","gaps","freshness"].every(
          (name) => auditDimensions.has(name))
        || dom.audit.misleadingHealthLabels !== 0
        || dom.audit.unstructuredSummary !== 1) {
      failures.push(`质量与来源未拆分四维或仍使用误导健康标签: ${JSON.stringify(dom.audit)}`);
    }
    if (dom.gapNoise?.visibleItems !== 1
        || dom.gapNoise.unstructuredSummary !== 1
        || !dom.gapNoise.summaryText.includes("1 个模块未结构化")) {
      failures.push(`模板型缺口未折叠降噪: ${JSON.stringify(dom.gapNoise)}`);
    }
    if (!dom.gapContext.includes("定位上下文")
        || !dom.gapContext.includes("页面\n详情页")
        || !dom.gapContext.includes("功能 / 流程\n查看订单详情")) {
      failures.push(`缺口详情缺少页面/功能/流程定位上下文: ${JSON.stringify(dom.gapContext)}`);
    }
    const scenario = dom.scenarioFlow ?? {};
    if (scenario.groups < 1 || scenario.steps < 2) {
      failures.push(`场景流程主干未渲染完整: ${JSON.stringify(scenario)}`);
    }
    if (!scenario.selector) failures.push("场景流程缺少业务场景选择器");
    if (scenario.selectedSteps !== 1 || scenario.interactionPanels !== 1 || scenario.interactions < 1) {
      failures.push(`场景步骤未展开唯一页面交互轨迹: ${JSON.stringify(scenario)}`);
    }
    if (scenario.roleLanes < 2
        || scenario.workflowLinks !== expectedWorkflowFacts.length) {
      failures.push(`场景流程未按角色泳道和模型主路径渲染: ${JSON.stringify(scenario)}`);
    }
    if (scenario.semanticIcons < scenario.steps || !scenario.interactionLegend
        || scenario.interactionFieldIcons < scenario.interactions * 5) {
      failures.push(`场景流程或交互卡缺少稳定语义图标: ${JSON.stringify(scenario)}`);
    }
    if (scenario.attachments < 1) failures.push("页面交互未精确挂载状态变化或异常");
    if (scenario.failureDisclosures < 1) failures.push("页面交互未提供可展开异常");
    if (!scenario.stepSwitch?.changed || !scenario.stepSwitch?.oneSelected
        || !scenario.stepSwitch?.hasInteractions
        || !scenario.stepSwitch?.firstHasOnlyException
        || !scenario.stepSwitch?.secondHasOnlyState) {
      failures.push(`场景步骤切换或精确附件挂载失败: ${JSON.stringify(scenario.stepSwitch)}`);
    }
    const branchKinds = scenario.branchKinds ?? {};
    if (branchKinds.failureBranch < 1 || branchKinds.pageState < 1
        || branchKinds.failureRecovery < 1 || branchKinds.stateImpact < 1) {
      failures.push(`流程未按四类事实绘制可对账分支: ${JSON.stringify(branchKinds)}`);
    }
    for (const kind of ["failureBranch","pageState","failureRecovery","stateImpact"]) {
      if (branchKinds[kind] !== expectedBranchKinds[kind]) {
        failures.push(
          `流程分支 ${kind} 与模型数量不一致: DOM=${branchKinds[kind]} model=${expectedBranchKinds[kind]}`);
      }
    }
    if (scenario.branchDisclosures < 1 || scenario.openBranchDisclosures !== 0) {
      failures.push(`异常分支默认未折叠: ${JSON.stringify(scenario)}`);
    }
    if (scenario.dependencyLanes < 1) failures.push("场景流程未渲染跨模块/外部依赖泳道");
    // ⑤ 场景连线：condition 为空/「—」占位不得渲染标签节点（fixture S2 条件为「—」）。
    var placeholderLinkLabels = (scenario.workflowLinkLabels || []).filter(
      function(text){return text === "" || text === "—";});
    if (placeholderLinkLabels.length > 0) {
      failures.push(`场景连线渲染了空/「—」占位标签: ${JSON.stringify(scenario.workflowLinkLabels)}`);
    }
    const provenCondition = (scenario.workflowLinkFacts || []).some(
      function(link){
        return link.from === "S1" && link.to === "S2"
          && link.condition === "订单存在";
      });
    if (!provenCondition) {
      failures.push(`场景连线未逐边保留真实条件: ${JSON.stringify(scenario.workflowLinkFacts)}`);
    }
    for (const [name, result] of Object.entries(dom.knowledgeViews ?? {})) {
      if (!result.tab || !result.visible || !result.scoped || result.cards < 1) {
        failures.push(`知识视图 ${name} 未完成可见渲染: ${JSON.stringify(result)}`);
      }
    }
    if (!dom.knowledgeViews?.field?.text.includes("订单编号")
        || !dom.knowledgeViews?.access?.text.includes("会员")
        || !dom.knowledgeViews?.access?.text.includes("访客")) {
      failures.push(`字段或访问规则内容不完整: ${JSON.stringify(dom.knowledgeViews)}`);
    }
    if (JSON.stringify(scenario.workflowLinkFacts || [])
        !== JSON.stringify(expectedWorkflowFacts)) {
      failures.push(
        `场景连线未与模型逐边对账: DOM=${JSON.stringify(scenario.workflowLinkFacts)} model=${JSON.stringify(expectedWorkflowFacts)}`);
    }
    if (!dom.pageContext?.primary.includes("入口")
        || !dom.pageContext.primary.includes("去向")
        || !dom.pageContext.provenDestination
        || !dom.pageContext.moduleOnlyAccess
        || dom.pageContext.progressiveSections < 4
        || !dom.pageContext.mappedData || !dom.pageContext.missingState) {
      failures.push(`页面详情未渐进披露或缺失语义不诚实: ${JSON.stringify(dom.pageContext)}`);
    }
    if (!dom.searchCoverage?.field || !dom.searchCoverage?.access) {
      failures.push(`全局搜索未覆盖字段与访问规则: ${JSON.stringify(dom.searchCoverage)}`);
    }
    if (!dom.searchNoResults?.includes("未找到匹配内容")) {
      failures.push(`全局搜索无结果状态不明确: ${JSON.stringify(dom.searchNoResults)}`);
    }
    if (!dom.lifecycle?.legend || !dom.lifecycle.archifySvg
        || dom.lifecycle.archifyMarker !== "lifecycle"
        || dom.lifecycle.expectedStates < 2
        || !dom.lifecycle.labelsAppearOnce
        || dom.lifecycle.builtInNodes !== 0
        || dom.lifecycle.traceButtons < dom.lifecycle.businessStates
        || !dom.lifecycle.semanticCopy.includes(
          "不代表业务起点或业务终态")
        || !dom.lifecycle.semanticCopy.includes(
          "流程中断也可能造成假终点")) {
      failures.push(`Lifecycle SVG 未唯一呈现状态或未保留追溯入口: ${JSON.stringify(dom.lifecycle)}`);
    }
    // ② Archify 内置英文 Legend 必须被 viewer 确定性移除，避免与 Atlas 中文图例重复。
    if (dom.lifecycle?.legendBridge !== 0) {
      failures.push(`Archify 内置 Legend 未从导入的 SVG 移除: legendBridge=${dom.lifecycle?.legendBridge}`);
    }
    // ③ 已声明 [*] 出口必须渲染为显式终点标记，且该标记不是业务状态。
    if (!dom.lifecycle?.declaredTerminalVisible
        || !(dom.lifecycle.expectedStates > dom.lifecycle.businessStates)) {
      failures.push(`已声明终点未作为非业务状态标记可见: ${JSON.stringify(dom.lifecycle)}`);
    }
    // 样式落地断言（2026-07-24 黑块回归的守门）：Archify SVG 是纯类名着色，
    // 结构在而样式丢时元素回落 fill:black——计算样式必须证明配色已生效。
    if (!dom.lifecycle?.styleTag || !dom.lifecycle.stateFill
        || dom.lifecycle.stateFill === "rgb(0, 0, 0)") {
      failures.push(`Lifecycle SVG 样式未落地(结构在/配色丢): styleTag=${
        dom.lifecycle?.styleTag} stateFill=${dom.lifecycle?.stateFill}`);
    }
    if (!fallback.riskBanner || fallback.builtInNodes < 2
        || fallback.archifySvgs !== 0 || !fallback.topRisk) {
      failures.push(`Lifecycle 降级路径不可达或风险未标注: ${JSON.stringify(fallback)}`);
    }
    if (!fallback.archEmbedHidden || fallback.archEmbedSvgs !== 0
        || fallback.builtInOverviewCards < 2) {
      failures.push(`Architecture 降级路径未回落到内建总览: ${JSON.stringify(fallback)}`);
    }
    if (!dom.architecture || dom.architecture.marker !== "architecture"
        || !dom.architecture.embedVisible || !dom.architecture.stageHidden
        || dom.architecture.components < 2
        || dom.architecture.labeledConnections < 1
        || dom.architecture.labeledConnections !== dom.architecture.totalConnections
        || !dom.architecture.styleTag || !dom.architecture.fill
        || dom.architecture.fill === "rgb(0, 0, 0)"
        || !dom.architecture.drilledToModule) {
      failures.push(`系统关系 Architecture 总览未嵌入/标签缺失/样式未落地/点击下钻不可用: ${JSON.stringify(dom.architecture)}`);
    }
    if (!dom.traceability?.summary.includes("会员可查看订单详情并完成订单")
        || dom.traceability.references < 1 || !dom.traceability.navigated
        || !dom.traceability.anchoredSource
        || !dom.traceability.drawerClosedOnTab
        || !dom.traceability.searchOpensDrawer) {
      failures.push(`需求摘要、反向跳转或来源定位不可审计: ${JSON.stringify(dom.traceability)}`);
    }
    if (failures.length > 0) {
      throw new Error(`浏览器断言失败:\n- ${failures.join("\n- ")}`);
    }

    console.log(`- 页面级横向裁切防护: ${JSON.stringify(dom.pageOverflow)}`);
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
    console.log(`- 场景流程、步骤切换与页面交互轨迹: ${JSON.stringify(dom.scenarioFlow)}`);
    console.log(`- Lifecycle SVG 与降级路径: ${JSON.stringify({svg:dom.lifecycle,fallback})}`);
    ws.close();
  } finally {
    if (chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill("SIGKILL");
      await exited;
    }
    // Chrome 的 zygote/renderer 子进程可能在父进程退出后仍短暂写 profile 目录，
    // 直连 rmSync 会撞 ENOTEMPTY（Linux CI 上偶发）。带重试；且清理失败不得让
    // 已经全部通过的断言判负——临时目录残留是环境问题，不是渲染器问题。
    try {
      rmSync(workDir, {
        recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`- 清理临时目录失败（不影响断言结论）: ${error.code || error.message}`);
    }
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
  console.log("渲染器验证证明继承成立（八个继承键全部一致），无需重新打开浏览器。");
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
