import type { Issue } from '../../lib/issues.js';

export const STOP_EVENTS = ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END', 'LOAD_START', 'LOAD_END', 'DEPARTED'] as const;
export const EXTRA_EVENTS = ['DOCS_SUBMITTED', 'DOCS_RETURNED', 'SEAL_CHECKED', 'TEMP_CHECKED'] as const;
export const GLOBAL_EVENTS = ['DELAYED', 'BREAKDOWN', 'EXCEPTION'] as const;
export const EVENT_CODES = [...STOP_EVENTS, ...EXTRA_EVENTS, ...GLOBAL_EVENTS] as const;
export const REASON_CODES = [
  'SHORTAGE', 'OVERAGE', 'DAMAGED', 'REFUSED_FULL', 'REFUSED_PARTIAL', 'CONSIGNEE_CLOSED', 'NO_RECEIVER',
  'WRONG_ADDRESS', 'DOCS_MISSING', 'TEMP_OUT_OF_RANGE', 'TRAFFIC', 'BREAKDOWN', 'WEATHER', 'CHECKPOINT', 'OTHER',
] as const;

export type StopEventCode = (typeof STOP_EVENTS)[number];
export type ExtraEventCode = (typeof EXTRA_EVENTS)[number];
export type EventCode = (typeof EVENT_CODES)[number];
export type ReasonCode = (typeof REASON_CODES)[number];

export interface StopState {
  hasDrops: boolean;
  hasPickups: boolean;
  done: Set<string>;
  allDropsHavePod: boolean;
}

export function stopSequence(hasDrops: boolean, hasPickups: boolean): StopEventCode[] {
  return [
    'ARRIVED',
    ...(hasDrops ? (['UNLOAD_START', 'UNLOAD_END'] as const) : []),
    ...(hasPickups ? (['LOAD_START', 'LOAD_END'] as const) : []),
    'DEPARTED',
  ];
}

export function checkStopEvent(state: StopState, code: StopEventCode, prevStopDeparted: boolean): Issue | null {
  const seq = stopSequence(state.hasDrops, state.hasPickups);
  const idx = seq.indexOf(code);
  if (idx === -1) return { code: 'EVENT_NOT_APPLICABLE', message: `${code} does not apply to this stop` };
  if (state.done.has(code)) return { code: 'EVENT_ALREADY_RECORDED', message: `${code} was already recorded for this stop` };
  if (code === 'ARRIVED' && !prevStopDeparted) return { code: 'PREVIOUS_STOP_OPEN', message: 'Depart the previous stop first' };
  const missing = seq.slice(0, idx).filter((c) => !state.done.has(c));
  if (missing.length > 0) return { code: 'EVENT_OUT_OF_ORDER', message: `Record ${missing.join(', ')} first`, details: { missing } };
  if (code === 'DEPARTED' && state.hasDrops && !state.allDropsHavePod) {
    return { code: 'POD_REQUIRED', message: 'Submit a POD for every delivery order dropped here before departing' };
  }
  return null;
}

export function checkExtraEvent(state: StopState, code: ExtraEventCode, allowed: string[]): Issue | null {
  if (!state.done.has('ARRIVED') || state.done.has('DEPARTED')) return { code: 'NOT_AT_STOP', message: `${code} can only be recorded while at the stop` };
  if (!allowed.includes(code)) return { code: 'EVENT_NOT_APPLICABLE', message: `${code} is not required by this client` };
  if (state.done.has(code)) return { code: 'EVENT_ALREADY_RECORDED', message: `${code} was already recorded for this stop` };
  return null;
}
