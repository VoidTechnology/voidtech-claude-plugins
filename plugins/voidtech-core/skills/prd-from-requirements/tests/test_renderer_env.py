"""渲染器验证环境与证明继承的纯 stdlib 单测（ADR-0005 §8；不起浏览器）。

契约：

- `atlas.renderer_env()`：返回八个继承键（atlas._PROOF_INHERIT_KEYS），
  全部为非空字符串，且纯函数——两次调用逐键相等。
- `atlas.render_fixture_html()`：确定性（两次逐字节一致）；输出即注入后的
  viewer 模板（自带内联脚本），注入锚点 `__ATLAS_*` 全部消费；转义探针
  标题中的 `<script>alert(1)</script>` 只以 `<` 转义（`\u003c`）后的 JSON
  文本形态出现，原文不会提前闭合承载模型的 `<script type="application/json">`。
- fixture 模型过 logic-model.schema.json 与 _validate_references——
  验证 harness 不得建立在无效模型上。
- assets/renderer-validation-proof.json 已提交且八键与当前
  renderer_env 一致（atlas.proof_inherits 为真）：任何改渲染器/fixture/
  harness 而不重签证明的提交在单测层即被抓住，不必等 CI 浏览器验证。
"""

import json
import unittest

from worktree_fixture import SKILL_ROOT

from prdsync import atlas
from prdsync.schema_validator import check, load_schema

PROOF_PATH = SKILL_ROOT / "assets" / "renderer-validation-proof.json"
RESIGN_HINT = "需重新浏览器验证：node scripts/validate-renderer.mjs --write"


class RendererEnvTest(unittest.TestCase):
    def test_env_has_all_inherit_keys_nonempty_and_stable(self):
        env = atlas.renderer_env()
        self.assertEqual(sorted(env), sorted(atlas._PROOF_INHERIT_KEYS))
        for key in atlas._PROOF_INHERIT_KEYS:
            self.assertIsInstance(env[key], str, key)
            self.assertTrue(env[key], f"{key} 不得为空")
        self.assertEqual(env, atlas.renderer_env())
        self.assertIn("archifyDigest", env)

    def test_fixture_html_deterministic_and_probe_escaped(self):
        html = atlas.render_fixture_html()
        self.assertEqual(html, atlas.render_fixture_html())
        # viewer 模板自带内联 <script>（注入锚点即 application/json 标签），
        # 故不再断言零 script；改为断言注入锚点已全部消费、探针以转义 JSON
        # 形态在场：< 转义为 \u003c，不会提前闭合承载模型的 <script> 标签。
        self.assertNotIn("__ATLAS_", html)
        self.assertIn('id="atlas-lifecycle"', html)
        self.assertIn("\\u003cscript>alert(1)\\u003c/script>", html)
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("Fixture-Home", html)
        for view in ("flow", "state", "boundary"):
            self.assertIn(f'id="tab-{view}"', html)
            self.assertIn(f'id="view-{view}"', html)

    def test_fixture_model_passes_schema_and_reference_validation(self):
        model = atlas._fixture_model()
        errors = check(model, load_schema(SKILL_ROOT / "schemas", "logic-model"))
        self.assertEqual(errors, [])
        self.assertEqual(atlas._validate_references(model), [])
        categories = {
            (node.get("detail") or {}).get("category")
            for node in model["nodes"]
        }
        self.assertTrue({
            "userFlow", "flowStep", "failureBranch", "terminal",
            "pageState", "businessState", "boundary",
        } <= categories)


class ProofFileTest(unittest.TestCase):
    def test_committed_proof_inherits_current_env(self):
        self.assertTrue(
            PROOF_PATH.exists(),
            f"缺少已提交的渲染器验证证明 {PROOF_PATH.name}；{RESIGN_HINT}")
        proof = json.loads(PROOF_PATH.read_text(encoding="utf-8"))
        env = atlas.renderer_env()
        for key in atlas._PROOF_INHERIT_KEYS:
            self.assertEqual(proof.get(key), env[key],
                             f"证明键 {key} 与当前渲染器环境不一致；{RESIGN_HINT}")
        self.assertIs(proof.get("browserValidated"), True)
        self.assertIn("validatedAt", proof)
        self.assertTrue(atlas.proof_inherits(proof, env))


if __name__ == "__main__":
    unittest.main()
