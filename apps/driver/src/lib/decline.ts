export const MIN_DECLINE_REASON_LENGTH = 3;

export function canSubmitReason(reason: string): boolean {
  return reason.trim().length >= MIN_DECLINE_REASON_LENGTH;
}
