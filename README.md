# articula-health

Turn natural-language arguments into a structured **knowledge graph** and render it on a static site — **without exposing your OPENAI_API_KEY**. The OpenAI call runs in a **GitHub Action** using repository secrets; the action commits `data/kg.json` back to the repo. The site (GitHub Pages) loads that JSON and shows an **interactive graph** (Cytoscape.js).

> **Live data flow:** Text argument → GitHub Action (OpenAI) → `data/kg.json` → Static viewer (`index.html`).

<img width="1389" height="923" alt="image" src="https://github.com/user-attachments/assets/f66ee495-1ae1-498a-b7c0-fbc62ec8905f" />

---

## Features
- **Interactive graph**: Pan/zoom, select nodes/edges, search, type filters, switchable layouts, PNG/JSON export (Cytoscape.js).
- **Clinical workflow view**: Left sidebar captures a structured *Session Record* with generated session ID/date, patient context, and ambient transcript; right sidebar summarizes evidence and highlights outstanding **Risk Factors**.
- **Risk coverage projection**: A second LLM pass replays risk factors against the session transcript to flag those not yet discussed by the clinician.
- **Reproducible**: Action re-generates `data/kg.json` on demand.
- **Portable**: Static viewer works on GitHub Pages or any static host.
- **Typed schema**: Nodes/edges use a constrained vocabulary suitable for downstream analysis.

---

## Project Structure
```
.
├─ index.html                 # Interactive viewer (Cytoscape.js)
├─ /data
│  └─ kg.json                 # Generated KG (committed by Action)
├─ /scripts
│  └─ extract.mjs             # Node: calls OpenAI, writes /data/kg.json
├─ package.json               # openai SDK dependency + scripts
├─ .gitignore
└─ .github/workflows
   └─ extract.yml             # GitHub Action: generates + commits kg.json
```

---

## Quick Start
1. **Use this repository template** (or copy files into your repo).
2. **Add secret**: `Settings → Secrets and variables → Actions → New repository secret`.
   - Name: `OPENAI_API_KEY`
   - Value: your OpenAI API key
3. **Enable GitHub Pages**: `Settings → Pages` → Build from the `main` branch (root).
4. **Run the workflow**: `Actions → Generate KG JSON → Run workflow`.
   - Optional inputs:
     - `text`: Inline passage to analyze (overrides default text)
     - `path`: Relative path to a text file in the repo (e.g., `inputs/foo.txt`)
     - `model`, `temperature`, `max_output_tokens`: Override model config (default model is `gpt-4o-mini`)
5. **Open the site**: Visit your Pages URL. You should see the interactive graph.

> To customize the input text, edit `TEXT` inside `scripts/extract.mjs` and rerun the workflow.

---

## Session Record Workflow
- The left sidebar captures a **Session Record** with an auto-filled record ID and session date followed by the clinical transcript. Edit this textarea before clicking **Analyze Session** to send new content through the extractor.
- A dedicated **Patient** panel surfaces demographics, problems, allergies, medications, vitals, and validations sourced from FHIR data (if available).
- During analysis, a modal progress indicator walks through `Extracting Medical Entities → Mapping Relationships → Risk Factors` so clinicians understand what the system is doing.
- The right insights pane summarizes key evidence and lists outstanding **Risk Factors** that may require additional diagnostics.
- After the KG is generated, a second LLM call projects every `RiskFactor` node back to the transcript and labels it as **Discussed**, **Not Discussed**, or **Uncertain**, with supporting quotes where available.

## Knowledge Graph in Medical Analysis
- The extractor maps each utterance in the session transcript to structured nodes (patients, findings, interventions, risk factors, etc.) and edges that capture clinical reasoning steps.
- Outstanding assumptions are flagged when required supporting relationships (e.g., `Evidence` or `Guideline` edges) are missing, allowing teams to see which claims still need validation.
- Risk factors inherit their status from both the session replay and the broader graph context; nodes lacking corroborating discussion are surfaced so clinicians can plan follow-up discussions or diagnostics.
- The resulting graph can be rerun across sessions to compare how open assumptions are being retired and which high-risk items persist for the patient cohort.

---

## How It Works
- `scripts/extract.mjs` constructs a prompt that asks the model to output **only JSON** with:
  - `nodes[]`: `{ id, type, label, attributes, source_span }`
  - `edges[]`: `{ source, type, target }`
  - `summary`: 2–3 sentences covering interventions, outcomes, assumptions, and remaining risk factors needing diagnostic confirmation
- The **GitHub Action** uses the repo secret `OPENAI_API_KEY` to run the extractor and commits the result to `/data/kg.json`.
- Immediately after KG extraction, the script runs a second model pass to project `RiskFactor` nodes back to the transcript and annotate whether the clinician discussed them.
- `index.html` fetches `/data/kg.json` and renders it as an **interactive graph** with Cytoscape.js.

---

## Security
- **Never commit your API key.** The key lives only in **repository secrets**.
- The browser never calls OpenAI. It only fetches the committed `data/kg.json`.
- The Action has `contents: write` permission to commit the JSON via the default `GITHUB_TOKEN`.

---

## Schema (Contract for `/data/kg.json`)
### Node Types
- `Population`, `Intervention`, `Comparator`, `Outcome`, `Condition`, `Medication`, `Procedure`, `Anatomy`, `Finding`, `Evidence`, `Mechanism`, `Guideline`, `TimeFrame`, `RiskFactor`, `Setting`

### Edge Types
- `treats`, `causes`, `contraindicated_for`, `indicates`, `administered_to`, `compared_with`, `measured_in`, `associated_with`, `supports`, `located_in`, `occurs_during`, `increases_risk_of`, `decreases_risk_of`, `part_of`

### Node Object
```json
{
  "id": "string-unique",
  "type": "Population|Intervention|…|RiskFactor|Setting",
  "label": "human-readable label",
  "attributes": {
    "metric_name": "if Outcome",
    "value": "if Outcome",
    "direction": "increase|decrease|stable",
    "unit": "unit string",
    "timeframe": "e.g., 9 months",
    "severity": "if RiskFactor",
    "likelihood": "if RiskFactor",
    "requires_additional_diagnostics": true
  },
  "source_span": "literal text excerpt (optional)"
}
```

> Only include attributes that are relevant/available for a given node type; leave them out when the source text does not supply the data.

### Edge Object
```json
{ "source": "node-id", "type": "treats|associated_with|…", "target": "node-id" }
```

---

## Viewer (index.html) Capabilities
- **Layouts**: CoSE Bilkent (default), Breadthfirst (L→R), Concentric, Grid
- **Filters** by node type (toggle risk factors, outcomes, etc.)
- **Search** (Enter to zoom/select by id/type/label)
- **Details panel** for selected node/edge (attributes, neighbors)
- **Export**: PNG (hi-res), JSON (current elements)
- **Clinical context panels**: Patient overview on the left, evidence and Risk Factor summaries on the right

> Styling and colors are assigned by node type; tweak in the `TYPE_STYLE` and `EDGE_STYLE` maps inside `index.html`.

---

## Configure the Model
You can configure via environment variables (in the Action or locally) without editing code:
- `MODEL` (default `gpt-5`)
- `TEMPERATURE` (default `0.2`)
- `MAX_OUTPUT_TOKENS` (default `4000`)
- `INPUT_TEXT` (inline text) or `INPUT_PATH` (file path relative to repo root)
- Risk projection overrides:
  - `RISK_MODEL` (default falls back to the main `MODEL`)
  - `RISK_TEMPERATURE` (default `0`)
  - `RISK_MAX_OUTPUT_TOKENS` (default `1600`)
  - `PROJECT_RISK_PROJECTION` (`false` to skip the second pass entirely)

You can also edit `PROMPT` in `scripts/extract.mjs` if you want to change the extraction instructions.

> The code expects the model to return **valid JSON**. If your model sometimes wraps JSON in text, the script includes a fallback extractor.

---

## Local Development
- Install deps: `npm i`
- Dry run extractor locally (requires local env var):
  ```bash
  export OPENAI_API_KEY=sk-... # do not commit
  # choose one of:
  # Inline text
  INPUT_TEXT="Your passage here" npm run extract
  # Or from file
  INPUT_PATH=inputs/sample.txt npm run extract
  # Optional model config
  MODEL=o3-mini TEMPERATURE=0.2 MAX_OUTPUT_TOKENS=4000 npm run extract
  ```
- Serve the viewer (any static server works), e.g.:
  ```bash
  npx http-server -c-1 .
  # open http://localhost:8080
  ```

---

## GitHub Action (/.github/workflows/extract.yml)
- Trigger: **manual dispatch** (`workflow_dispatch`)
- Steps: checkout → setup Node → install deps → run extractor (with secret) → auto-commit `data/kg.json`
- Permissions: `contents: write`

To re-run, go to **Actions** → *Generate KG JSON* → **Run workflow**.

---

## Customization Ideas
- **Multiple passages**: store inputs in `/inputs/*.txt`, iterate in the Action, and generate `/data/*.json` per input.
- **Compare arguments**: render tabs or a dropdown to switch graphs.
- **Color by polarity/confidence**: map `attributes.polarity`/`confidence` to hues/opacity.
- **Advanced UI**: swap Cytoscape for a React app (e.g., Next.js) if you want routing/state, keeping extraction in Actions.

---

## Troubleshooting
- **Viewer says it can’t load `data/kg.json`**: Run the Action once so the file exists. Ensure Pages points to the same branch.
- **Action fails: `API key not set`**: Add the `OPENAI_API_KEY` repo secret and ensure the `Run extractor` step passes it via `env`.
- **Graph looks empty**: Inspect `data/kg.json` in the repo → confirm `nodes`/`edges` arrays are populated and node ids are unique.
- **Janky layout**: Try another layout (Breadthfirst for causal flow), then tweak `idealEdgeLength`/`nodeRepulsion` in `index.html`.
- **JSON parse errors**: Increase `max_output_tokens`; the script includes a JSON-block fallback extractor.

---

## License
MIT (add a LICENSE file if you need one)
