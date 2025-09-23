import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import Ajv from 'ajv';

// API key is provided by GitHub Actions via env var
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function aggregateResponseText(resp){
  try{
    const aggregates = [];
    const outputItems = Array.isArray(resp?.output) ? resp.output : (Array.isArray(resp?.outputs) ? resp.outputs : []);
    for (const item of outputItems) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const seg of content) {
        if (typeof seg?.text === 'string' && seg.text.trim()) aggregates.push(seg.text.trim());
        else if (typeof seg?.content === 'string' && seg.content.trim()) aggregates.push(seg.content.trim());
      }
    }
    if (!aggregates.length && Array.isArray(resp?.choices) && resp.choices[0]?.message?.content) {
      aggregates.push(String(resp.choices[0].message.content));
    }
    return aggregates.join('\n').trim();
  } catch { return ''; }
}

function repairJsonText(s){
  let t = s;
  if (/^```/.test(t)) {
    t = t.replace(/^```[a-zA-Z]*\n?|```$/g, '');
  }
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/,\s*(\}|\])/g, '$1');
  t = t.replace(/([\{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  t = t.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  return t;
}

async function callModelWithBackoff(initialParams){
  let params = { ...initialParams };
  let resp;
  for (let i = 0; i < 3; i++) {
    try {
      resp = await client.responses.create(params);
      break;
    } catch (e) {
      const msg = String(e?.message || '');
      const badParam = e?.error?.param || '';
      if ((badParam === 'temperature' || /temperature/i.test(msg)) && 'temperature' in params) {
        delete params.temperature;
        continue;
      }
      if ((badParam === 'max_output_tokens' || /max[_ ]?output[_ ]?tokens/i.test(msg)) && 'max_output_tokens' in params) {
        delete params.max_output_tokens;
        continue;
      }
      if ((badParam === 'response_format' || /response[_ ]?format/i.test(msg)) && 'response_format' in params) {
        delete params.response_format;
        continue;
      }
      throw e;
    }
  }
  if (!resp) throw new Error('Failed to call model after removing unsupported parameters');
  return resp;
}

function parseModelJson(resp, context = 'model output'){
  const label = context || 'model output';
  let jsonText = '';
  if (resp) {
    jsonText = (resp.output_text ?? '').trim();
  }
  if (!jsonText) {
    jsonText = aggregateResponseText(resp);
  }
  if (!jsonText) {
    throw new Error(`${label}: model returned empty output`);
  }
  let candidate = jsonText.trim();
  if (!candidate.startsWith('{')) {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (match) candidate = match[0];
  }
  try {
    return JSON.parse(candidate);
  } catch (err) {
    const repaired = repairJsonText(candidate);
    try {
      return JSON.parse(repaired);
    } catch (err2) {
      console.error(`${label}: Model output was not valid JSON. Raw (first 500 chars):\n`, candidate.slice(0, 500));
      throw err2;
    }
  }
}

// === Default input text; used when no CLI argument is provided ===
const DEFAULT_TEXT = `Over the past nine months, after Acme Transit deployed dynamic pricing and AI-driven bus dispatching across three pilot districts, average wait times decreased by 18%, rider satisfaction scores rose from 3.6 to 4.2 out of 5, and fare evasion citations declined by 11%. The operations team reports that the reduction in wait times is primarily due to the dispatch model reallocating idle buses to corridors with sudden demand spikes. The CFO argues that the improved satisfaction and lower evasion together indicate a durable behavioral shift that will sustain even if promotional discounts are removed next quarter. Therefore, the agency should expand dynamic pricing citywide starting in Q4 and phase out manual dispatching within two quarters.

However, multiple external factors changed during the pilot period: two major road construction projects concluded, a new rideshare competitor exited the market, and fuel prices fell 9% relative to last year. The pilot districts also received targeted marketing that was not provided to control districts. Some community stakeholders claim the fare cuts primarily attracted price-sensitive riders temporarily, and that once discounts taper off, both satisfaction and ridership will revert. Others contend the decline in evasion reflects stepped-up enforcement rather than improved perceptions of fairness.

In short, we observe improvements in wait times, satisfaction, and enforcement outcomes, and leadership claims these were caused by AI dispatching and dynamic pricing. The recommended action is to scale the program citywide and reorganize operations around the AI system.

Assumptions include: (1) the observed improvements are not largely explained by seasonality or exogenous shocks (e.g., the end of construction and competitor exit), (2) the relationship between dynamic pricing and satisfaction is causal rather than confounded by marketing, (3) decreased evasion was not mainly driven by enforcement intensity, (4) the dispatch model will generalize to districts with different route geometries and demand variability, and (5) any initial novelty effects will not fade materially over the next two quarters.

If these assumptions hold, then scaling AI dispatching and dynamic pricing should produce citywide improvements in service reliability and perceived fairness, justifying a phased deprecation of manual dispatching.`;

async function resolveInputText(){
	// Accept input from CLI args:
	// - If one arg refers to an existing file, read its contents
	// - Otherwise, treat all args joined with spaces as the input text
	// - If no args, use DEFAULT_TEXT
	const args = process.argv.slice(2);
	if (args.length === 0) return DEFAULT_TEXT;
	if (args.length === 1) {
		const candidatePath = args[0];
		const filePath = path.isAbsolute(candidatePath) ? candidatePath : path.join(process.cwd(), candidatePath);
		try {
			const st = await fs.stat(filePath);
			if (st.isFile()) return fs.readFile(filePath, 'utf8');
		} catch {}
	}
	return args.join(' ').trim();
}

// Comprehensive medical text extraction prompt with enhanced quality instructions
const PROMPT = `You are an expert medical information extraction and knowledge graph assistant specializing in identifying both explicit and implicit medical information.

Your task: Extract a comprehensive knowledge graph from medical text, paying special attention to hidden assumptions and unstated risks.

IMPORTANT: You MUST use ONLY these exact node types (case-sensitive):
- Population (patient groups, cohorts, clinics, demographics)
- Intervention (treatments, procedures, deployments, systems, technologies)
- Comparator (control groups, baseline methods, alternative treatments)
- Outcome (results, metrics, improvements - ALWAYS include metric_name, value, direction, unit, timeframe in attributes)
- Condition (diseases, diagnoses, medical problems, symptoms)
- Medication (drugs, dosages, formulations)
- Procedure (medical procedures, diagnostic tests, surgical operations)
- Anatomy (body parts, organs, anatomical structures)
- Finding (clinical observations, discoveries, patterns)
- Evidence (studies, data, research supporting claims)
- Mechanism (biological/technical mechanisms, pathways, how interventions work)
- Guideline (recommendations, protocols, clinical guidelines, standards)
- TimeFrame (durations, periods, timing, schedules)
- RiskFactor (risks, adverse factors, complications, limitations, biases)
- Setting (locations, care settings, healthcare facilities)

FORBIDDEN node types (DO NOT USE): Actor, CausalClaim, Assumption, Recommendation, OutcomeMetric, TimeRef

Allowed edge types: treats, causes, contraindicated_for, indicates, administered_to, compared_with, measured_in, associated_with, supports, located_in, occurs_during, increases_risk_of, decreases_risk_of, part_of

Output schema (MUST follow exactly):
{
  "nodes": [
    { "id": "string", "type": "<Allowed node type>", "label": "string", "attributes": {"...": "..."}, "source_span": "string" }
  ],
  "edges": [
    { "source": "nodeId", "type": "<Allowed edge type>", "target": "nodeId" }
  ],
  "summary": "string (comprehensive 2-3 sentence summary highlighting key interventions, outcomes, critical assumptions, and remaining risk factors requiring diagnostic confirmation)"
}

CRITICAL EXTRACTION RULES:

1. IMPLICIT ASSUMPTIONS (Create RiskFactor nodes for ALL of these):
   • Causality assumptions - When correlation is presented as causation
   • Generalizability issues - Will results apply to different populations/settings?
   • Unmeasured confounders - What concurrent changes could explain outcomes?
   • Measurement validity - Are metrics truly measuring intended outcomes?
   • Sustainability concerns - Will improvements persist beyond study period?
   • Implementation requirements - Hidden resource/expertise/infrastructure needs
   • Selection biases - Is the study population truly representative?
   • Time-dependent biases - Seasonal effects, learning curves, novelty effects
   • Missing comparisons - What alternatives weren't evaluated?
   • Data quality issues - Incomplete data, coding changes, documentation shifts

2. NODE ATTRIBUTE REQUIREMENTS:
   • Outcome nodes: MUST include metric_name, value, direction, unit, timeframe
   • Population nodes: Include demographics (size, age, gender, conditions)
   • Medication nodes: Include dosage, route, frequency when available
   • Intervention nodes: Include technical details, deployment specifics
   • RiskFactor nodes: Include severity, likelihood, and whether additional diagnostics are required to confirm if mentioned

3. QUALITY STANDARDS:
   • Extract ALL numerical values and associate with appropriate nodes
   • Identify ALL time periods and create TimeFrame nodes
   • Link all outcomes to their interventions via edges
   • Connect risk factors to affected outcomes
   • Create Evidence nodes for supporting data/studies mentioned
   • Ensure every claim has supporting evidence or is marked as assumption

4. SUMMARY REQUIREMENTS:
  • First sentence: Key intervention and primary outcomes
  • Second sentence: Critical assumptions or limitations identified
  • Third sentence: Remaining risk factors that may need confirmation through additional diagnostics

Return ONLY valid JSON. No additional text.`;

const RISK_PROJECTION_PROMPT = `You are a clinical QA assistant that ensures risk factors from a knowledge graph were properly discussed in a clinical session transcript.

For each provided risk factor node, determine whether the clinician explicitly addressed it in the session (e.g., offered mitigation, counseling, follow-up diagnostics, or monitoring). Classify using ONLY these statuses:
- addressed: the clinician acknowledged the risk and documented a plan or next step.
- not_addressed: the risk factor was not mentioned or handled by the clinician.
- uncertain: there is insufficient evidence to decide.

Output must be valid JSON matching this schema:
{
  "risk_factors": [
    {
      "id": "<node id>",
      "label": "<risk label>",
      "status": "addressed|not_addressed|uncertain",
      "doctor_quote": "brief quote from the doctor supporting the classification or empty string",
      "patient_quote": "brief quote from the patient if relevant or empty string",
      "rationale": "1-2 sentence explanation tying the transcript back to the classification"
    }
  ],
  "summary": "2 sentence overview highlighting addressed vs missing risk factors"
}

Use empty strings when quotes are unavailable. Quote only the minimal necessary span from the transcript. Respond with JSON only.`;

async function projectRiskCoverage(sessionText, kg, opts = {}){
  const transcript = typeof sessionText === 'string' ? sessionText.trim() : '';
  if (!transcript) return null;

  const riskNodes = Array.isArray(kg?.nodes)
    ? kg.nodes.filter(n => n && n.type === 'RiskFactor')
    : [];
  if (riskNodes.length === 0) {
    return { risk_factors: [], summary: 'No risk factors detected in knowledge graph.' };
  }

  const rawModel = opts.model || process.env.RISK_MODEL || process.env.RISK_PROJECTION_MODEL || opts.fallbackModel || process.env.ANALYZE_MODEL || process.env.MODEL || 'gpt-4o-mini';
  const model = String(rawModel || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const temperatureInput = opts.temperature ?? process.env.RISK_TEMPERATURE;
  const maxTokensInput = opts.max_output_tokens ?? process.env.RISK_MAX_OUTPUT_TOKENS;
  const temperature = Number.isFinite(Number(temperatureInput)) ? Number(temperatureInput) : 0;
  const max_output_tokens = Number.isFinite(Number(maxTokensInput)) ? Number(maxTokensInput) : 1600;

  const minimalRiskNodes = riskNodes.map(n => ({
    id: n.id,
    label: n.label,
    attributes: n.attributes || {},
    source_span: n.source_span || ''
  }));

  const input = `${RISK_PROJECTION_PROMPT}\n\nSession Record Transcript:\n"""${transcript}"""\n\nRisk Factor Nodes (JSON array):\n${JSON.stringify(minimalRiskNodes, null, 2)}`;

  const params = {
    model,
    input,
    response_format: { type: 'json_object' }
  };
  if (Number.isFinite(temperature)) params.temperature = temperature;
  if (Number.isFinite(max_output_tokens)) params.max_output_tokens = max_output_tokens;

  const resp = await callModelWithBackoff(params);
  const projection = parseModelJson(resp, 'Risk factor projection');

  if (!projection || !Array.isArray(projection.risk_factors)) {
    throw new Error('Risk factor projection response missing risk_factors array');
  }

  const allowedStatuses = new Set(['addressed', 'not_addressed', 'uncertain']);
  projection.risk_factors = projection.risk_factors
    .filter(rf => rf && typeof rf.id === 'string' && rf.id.trim())
    .map(rf => {
      const statusRaw = typeof rf.status === 'string' ? rf.status.trim().toLowerCase() : 'uncertain';
      const status = allowedStatuses.has(statusRaw) ? statusRaw : 'uncertain';
      return {
        id: rf.id.trim(),
        label: typeof rf.label === 'string' ? rf.label.trim() : '',
        status,
        doctor_quote: typeof rf.doctor_quote === 'string' ? rf.doctor_quote.trim() : '',
        patient_quote: typeof rf.patient_quote === 'string' ? rf.patient_quote.trim() : '',
        rationale: typeof rf.rationale === 'string' ? rf.rationale.trim() : ''
      };
    });

  if (!Array.isArray(projection.risk_factors)) {
    projection.risk_factors = [];
  }
  if (typeof projection.summary === 'string') {
    projection.summary = projection.summary.trim();
  } else {
    projection.summary = '';
  }

  return projection;
}

export async function extractToKg(inputText, opts = {}){
  const model = (opts.model || process.env.MODEL || 'gpt-4o-mini').trim();
  const temperature = Number.isFinite(Number(opts.temperature ?? process.env.TEMPERATURE)) ? Number(opts.temperature ?? process.env.TEMPERATURE) : 0.2;
  const max_output_tokens = Number.isFinite(Number(opts.max_output_tokens ?? process.env.MAX_OUTPUT_TOKENS)) ? Number(opts.max_output_tokens ?? process.env.MAX_OUTPUT_TOKENS) : 4000;

  const input = `${PROMPT}\n\nText to analyze:\n\n"""${inputText}"""`;

  const params = {
    model,
    input,
    response_format: { type: 'json_object' }
  };
  if (Number.isFinite(temperature)) params.temperature = temperature;
  if (Number.isFinite(max_output_tokens)) params.max_output_tokens = max_output_tokens;

  const resp = await callModelWithBackoff(params);
  const json = parseModelJson(resp, 'Knowledge graph extraction');

  const projectionToggleEnv = typeof process.env.PROJECT_RISK_PROJECTION === 'string'
    ? process.env.PROJECT_RISK_PROJECTION.trim().toLowerCase() !== 'false'
    : true;
  const projectionToggle = typeof opts.projectRiskCoverage === 'boolean' ? opts.projectRiskCoverage : projectionToggleEnv;

  if (projectionToggle) {
    const projection = await projectRiskCoverage(inputText, json, {
      model: opts.risk_model || opts.riskModel,
      temperature: opts.risk_temperature ?? opts.riskTemperature,
      max_output_tokens: opts.risk_max_output_tokens ?? opts.riskMaxOutputTokens,
      fallbackModel: model
    });
    if (projection) {
      json.risk_projection = projection;
      if (Array.isArray(json.nodes)) {
        const coverageMap = new Map((projection.risk_factors || []).map(rf => [rf.id, rf]));
        for (const node of json.nodes) {
          if (node && node.type === 'RiskFactor') {
            const info = coverageMap.get(node.id);
            if (info) {
              node.attributes = node.attributes || {};
              node.attributes.coverage_status = info.status;
              if (info.doctor_quote) node.attributes.doctor_quote = info.doctor_quote;
              if (info.patient_quote) node.attributes.patient_quote = info.patient_quote;
              if (info.rationale) node.attributes.coverage_rationale = info.rationale;
            }
          }
        }
      }
    }
  }

	// Post-process common field mismatches (e.g., name -> label)
	if (json && Array.isArray(json.nodes)) {
		for (const n of json.nodes) {
			if (n && typeof n === 'object') {
				// Fill missing label from common alternatives
				if (!n.label) {
					const alt = n.name || n.title || n.text || n.value || (n.attributes && (n.attributes.label || n.attributes.name || n.attributes.title));
					if (alt) n.label = String(alt);
					if (!n.label && n.id) n.label = String(n.id);
				}
				if (typeof n.label === 'string') n.label = n.label.trim();
			}
		}
	}

  // JSON Schema validation and consistency checks
  const ajv = new Ajv({ allErrors: true, strict: false });
  const nodeTypes = [
		'Population','Intervention','Comparator','Outcome','Condition','Medication',
		'Procedure','Anatomy','Finding','Evidence','Mechanism','Guideline',
		'TimeFrame','RiskFactor','Setting'
	];
  const edgeTypes = [
		'treats','causes','contraindicated_for','indicates','administered_to',
		'compared_with','measured_in','associated_with','supports','located_in',
		'occurs_during','increases_risk_of','decreases_risk_of','part_of'
	];
  const schema = {
		type: 'object',
		required: ['nodes','edges'],
		properties: {
			summary: { type: 'string' },
			nodes: {
				type: 'array',
				items: {
					type: 'object',
					required: ['id','type','label'],
					properties: {
						id: { type: 'string', minLength: 1 },
						type: { type: 'string', enum: nodeTypes },
						label: { type: 'string' },
						attributes: { type: 'object', additionalProperties: true },
						source_span: { type: 'string' }
					},
					additionalProperties: true
				}
			},
			edges: {
				type: 'array',
				items: {
					type: 'object',
					required: ['source','type','target'],
					properties: {
						source: { type: 'string', minLength: 1 },
						type: { type: 'string', enum: edgeTypes },
						target: { type: 'string', minLength: 1 }
					},
					additionalProperties: true
				}
			}
		},
		additionalProperties: true
  };
  const validate = ajv.compile(schema);
  const valid = validate(json);
  if (!valid) {
		const msg = validate.errors?.map(e => `${e.instancePath} ${e.message}`).join('; ');
		throw new Error(`Invalid KG schema: ${msg}`);
  }

  // Consistency checks: unique node ids and edge references
  const ids = new Set();
  for (const n of json.nodes) {
		if (ids.has(n.id)) throw new Error(`Duplicate node id: ${n.id}`);
		ids.add(n.id);
  }
  for (const e of json.edges) {
		if (!ids.has(e.source)) throw new Error(`Edge source not found: ${e.source}`);
		if (!ids.has(e.target)) throw new Error(`Edge target not found: ${e.target}`);
  }

	if (opts.writeFile !== false){
		const baseDir = (typeof opts.baseDir === 'string' && opts.baseDir) ? opts.baseDir : process.cwd();
		const outPath = typeof opts.outputPath === 'string' && opts.outputPath
			? (path.isAbsolute(opts.outputPath) ? opts.outputPath : path.join(baseDir, opts.outputPath))
			: path.join(baseDir, 'data', 'kg.json');
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		await fs.writeFile(outPath, JSON.stringify(json, null, 2));
		console.log('Wrote', outPath);
	}
  return json;
}

async function run(){
  const inputText = await resolveInputText();
  await extractToKg(inputText);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(err => { console.error(err); process.exit(1); });
}
