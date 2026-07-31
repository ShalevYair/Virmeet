// Virmeet — module-level registry mapping a running meeting to its AbortController.
//
// Lets PATCH /api/meetings/[id] (status:'cancelled') abort an in-flight model
// call immediately when the run happens to live in this same server process,
// instead of only relying on the next store-backed cancellation check inside
// runMeeting() (which fires at most once per turn — see P1.1).

const controllers = new Map<string, AbortController>();

export function registerRun(meetingId: string, controller: AbortController): void {
  controllers.set(meetingId, controller);
}

export function unregisterRun(meetingId: string): void {
  controllers.delete(meetingId);
}

/** Returns true if a live run was found in this process and aborted. */
export function abortRun(meetingId: string): boolean {
  const controller = controllers.get(meetingId);
  if (!controller) return false;
  controller.abort();
  return true;
}
