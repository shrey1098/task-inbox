// What each model costs, and what each model can be asked to do.
//
// Two jobs in one file because they have the same shape: both are per-model
// facts that the extractor and the usage page need to agree on. Keeping them
// together means adding a model is one edit, not three.
//
// Prices are US dollars per million tokens, from Anthropic's published rates.
// They are applied at the moment a call is recorded, never at read time — see
// costOf below for why.

const MTOK = 1_000_000;

/**
 * The models this app knows how to price and drive.
 *
 * `effort` says whether the model accepts output_config.effort. This is not a
 * nicety: Haiku 4.5 and Sonnet 4.5 REJECT the parameter with a 400, so sending
 * it to them breaks every extraction. The extractor reads this flag rather
 * than hardcoding a model name, so switching ANTHROPIC_MODEL is safe.
 */
const MODELS = {
  'claude-haiku-4-5': {
    label: 'Haiku 4.5',
    input: 1, output: 5,
    effort: false, // 400s on this model — see above
  },
  'claude-sonnet-5': {
    label: 'Sonnet 5',
    input: 3, output: 15,
    effort: true,
    // Introductory pricing. Recorded calls are priced when they happen, so
    // this simply stops applying once the date passes — no migration needed.
    intro: { input: 2, output: 10, until: Date.parse('2026-09-01T00:00:00Z') },
  },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6', input: 3, output: 15, effort: true },
  'claude-opus-5':     { label: 'Opus 5',     input: 5, output: 25, effort: true },
  'claude-opus-4-8':   { label: 'Opus 4.8',   input: 5, output: 25, effort: true },
  'claude-opus-4-7':   { label: 'Opus 4.7',   input: 5, output: 25, effort: true },
  'claude-opus-4-6':   { label: 'Opus 4.6',   input: 5, output: 25, effort: true },
  'claude-fable-5':    { label: 'Fable 5',    input: 10, output: 50, effort: true },
};

/**
 * An unknown model is priced at zero rather than guessed at.
 *
 * A wrong number that looks authoritative is worse than a visible blank: the
 * usage page shows the token counts either way, and flags the model as
 * unpriced, so you can see the traffic and know the money figure is missing.
 */
const UNKNOWN = { label: null, input: 0, output: 0, effort: false, unknown: true };

/**
 * Look up a model, tolerating a dated snapshot id.
 *
 * Anthropic publishes both an alias (claude-haiku-4-5) and a dated full id
 * (claude-haiku-4-5-20251001). Which one an account accepts is not something
 * this app can know, and getting it wrong is a 404 at call time — so the table
 * is keyed by alias and a trailing -YYYYMMDD is stripped before the lookup.
 * That way pricing, labels and the effort flag all keep working whichever form
 * ANTHROPIC_MODEL is set to, and a future dated id needs no table edit.
 */
function modelInfo(model) {
  const id = String(model || '');
  return MODELS[id] ?? MODELS[id.replace(/-\d{8}$/, '')] ?? UNKNOWN;
}

/** Does this model accept output_config.effort? */
function supportsEffort(model) {
  return modelInfo(model).effort === true;
}

/** Human-readable name for the usage page; falls back to the raw id. */
function labelFor(model) {
  return modelInfo(model).label ?? model;
}

/** The rates in force at a given moment, honouring any introductory period. */
function ratesAt(model, at = Date.now()) {
  const info = modelInfo(model);
  if (info.intro && at < info.intro.until) {
    return { input: info.intro.input, output: info.intro.output, unknown: false };
  }
  return { input: info.input, output: info.output, unknown: info.unknown === true };
}

/**
 * Dollar cost of one API call.
 *
 * Cache reads bill at a tenth of the input rate and cache writes at 1.25x, so
 * they are counted separately rather than lumped into input_tokens — the API
 * reports them as separate fields precisely because they are priced apart.
 *
 * Cost is computed here, at record time, and stored on the row. Doing it at
 * read time would silently rewrite history every time a price changed or an
 * introductory period lapsed, and a usage page that quietly restates last
 * month's spend is worse than no usage page.
 */
function costOf(usage, model, at = Date.now()) {
  const { input, output } = ratesAt(model, at);
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  return (
    (inTok * input) +
    (outTok * output) +
    (cacheWrite * input * 1.25) +
    (cacheRead * input * 0.1)
  ) / MTOK;
}

module.exports = { MODELS, modelInfo, supportsEffort, labelFor, ratesAt, costOf };
