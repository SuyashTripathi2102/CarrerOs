/**
 * The retirement drop guard's switch and its startup check.
 *
 * Two things are decided once, when the API starts:
 *
 *   recording  Company crawls write a distinct `jobsFound` and the run flags
 *              `complete` and `reconciled`. On whenever crawl_runs has those
 *              two columns, whatever the switch says, so references already
 *              exist when the switch is turned on. Without the columns nothing
 *              new is written, and a crawl behaves exactly as before the guard.
 *   dropGuard  NO_REFERENCE and SUDDEN_DROP are applied. Needs the switch AND
 *              the columns: the previous valid crawl is read from `complete`.
 *
 * Anything uncertain resolves to off, which is the behaviour from before the
 * guard. Changing the switch or the schema takes an API restart.
 */

export const RETIREMENT_DROP_GUARD = 'RETIREMENT_DROP_GUARD';

export interface RetirementGuardState {
  recording: boolean;
  dropGuard: boolean;
}

export const RETIREMENT_GUARD_OFF: Readonly<RetirementGuardState> =
  Object.freeze({
    recording: false,
    dropGuard: false,
  });

/** `off` (the default) or `on`. Anything else is reported and read as off. */
export function parseRetirementDropGuard(raw: string | undefined): {
  on: boolean;
  invalid: boolean;
} {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'off') return { on: false, invalid: false };
  if (value === 'on') return { on: true, invalid: false };
  return { on: false, invalid: true };
}

interface GuardLog {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * @param hasRunFlagColumns resolves true when crawl_runs has boolean columns
 *   `complete` and `reconciled`, the ones the A-01 schema adds.
 */
export async function resolveRetirementGuard(
  raw: string | undefined,
  hasRunFlagColumns: () => Promise<boolean>,
  log: GuardLog,
): Promise<RetirementGuardState> {
  const requested = parseRetirementDropGuard(raw);
  if (requested.invalid) {
    log.warn(
      `${RETIREMENT_DROP_GUARD} is set to something other than off or on; treated as off`,
    );
  }

  let columns: boolean;
  try {
    columns = await hasRunFlagColumns();
  } catch (err) {
    log.error(
      `retirement guard: could not check crawl_runs for complete/reconciled ` +
        `(${err instanceof Error ? err.message : String(err)}); recording and the drop guard stay off`,
    );
    return { ...RETIREMENT_GUARD_OFF };
  }

  if (requested.on && !columns) {
    log.error(
      `${RETIREMENT_DROP_GUARD}=on, but crawl_runs has no complete/reconciled columns, ` +
        `so the previous valid crawl cannot be read; the drop guard stays off`,
    );
  }
  const state: RetirementGuardState = {
    recording: columns,
    dropGuard: requested.on && columns,
  };
  log.log(
    `retirement guard: recording ${state.recording ? 'on' : 'off'}, drop guard ${state.dropGuard ? 'on' : 'off'}`,
  );
  return state;
}
