# English AI-prose reference

Read this when editing English or mixed Chinese-English text.

## First identify the register

Do not push every piece toward casual blog prose.

- Technical documentation should be plain, precise, and stable.
- Product copy should trade hype for concrete use, audience, and outcome.
- Essays and posts can keep opinion, uneven rhythm, and first person.
- Academic or reference prose should stay neutral. Remove puffery, not rigor.

## Common AI tells

### 1. Significance inflation

Watch for: serves as, stands as, testament, reminder, pivotal, crucial, underscores, highlights the importance, broader landscape, enduring legacy, marks a shift, key moment.

Fix: replace symbolic claims with concrete facts, causes, constraints, or effects.

Before: The launch marks a pivotal moment in the evolution of developer tooling.

After: The launch adds a local test runner and a review queue for generated patches.

### 2. Promotional language

Watch for: vibrant, rich, profound, groundbreaking, seamless, intuitive, powerful, must-visit, nestled, boasts, showcases, commitment to.

Fix: remove adjectives that do not add verifiable information.

Before: The platform offers a seamless, powerful workflow for modern teams.

After: The platform lets reviewers approve, reject, or edit generated changes in one queue.

### 3. Superficial `-ing` clauses

Watch for sentence tails such as highlighting, underscoring, ensuring, reflecting, showcasing, fostering, enabling.

Fix: split the sentence or turn the claim into a specific action.

Before: The dashboard unifies metrics, enabling teams to make better decisions.

After: The dashboard shows revenue, churn, and support volume on one screen.

### 4. Vague attribution

Watch for: experts argue, observers note, industry reports suggest, some critics say, sources indicate.

Fix: name the source, state the evidence, or remove the claim.

### 5. Rule of three

Watch for neat triplets: innovation, collaboration, and growth; ideate, iterate, and deliver.

Fix: keep only real categories. Use two, four, or a sentence with specific detail.

### 6. Copula avoidance

Watch for replacing simple verbs with ceremony: serves as, functions as, represents, boasts, features.

Fix: prefer is, are, has, uses when they are clearer.

### 7. Negative parallelism

Watch for: not only X but Y; not just X, it is Y; no guessing; no wasted motion.

Fix: write the positive claim directly.

Before: It is not just autocomplete; it is a partner in the creative process.

After: It suggests code, tests, and small refactors while the developer reviews the result.

### 8. Formatting tells

- Remove decorative emojis unless the target format expects them.
- Avoid mechanical bold labels in every bullet.
- Use sentence case headings unless the surrounding style requires title case.
- Replace em dashes and en dashes when they create a sales-like rhythm. Use a period, comma, colon, parentheses, or a rewritten sentence.
- Straight quotes are usually safer in code-adjacent text. Do not change publication style guides that intentionally use curly quotes.

### 9. Chatbot artifacts

Remove: Of course, Certainly, Great question, I hope this helps, Let me know, Would you like me to, Here is a, Let's dive in, Let's explore, Without further ado.

### 10. Hedging and filler

Watch for: it is important to note, in order to, due to the fact that, at this point in time, could potentially possibly be argued, based on available information.

Fix: shorten without overstating certainty.

Before: It could potentially be argued that the policy may have some effect.

After: The policy may affect the outcome.

### 11. Generic upbeat conclusions

Watch for: the future looks bright, exciting times lie ahead, this is a step in the right direction, the journey continues.

Fix: end with a concrete next step, limitation, result, or unresolved question.

### 12. Manufactured punchlines

Watch for stacks of short dramatic fragments, fake-candid openers, and aphorisms: Here's the thing, Honestly?, X is the Y of Z, the architecture of, the currency of.

Fix: say the claim directly and keep only the emphasis that earns its place.

## False positives

Do not flag a sentence just because it is polished, formal, uses one transition word, contains one em dash, or has correct formatting. Look for clusters. The problem is usually a combination of rhythm, abstraction, vague evidence, and overconfident framing.

## Final self-check

- Did the rewrite preserve all facts and constraints?
- Did it replace vague praise with specific information?
- Does the rhythm vary without becoming theatrical?
- Are uncertain claims still uncertain?
- Does the ending say something real?
