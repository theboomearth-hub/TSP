/** A topic brief lasts 24 hours; writing from an expired or unknown one needs a fresh search. */
export class TopicBriefUnavailableError extends Error {
  readonly status = 410;
  readonly code = "topic_expired";
  constructor() { super("These stories are no longer available. Search the topic again to write about it."); }
}

export const topicBriefFailure = (error: TopicBriefUnavailableError) => ({ status: error.status, body: { code: error.code, message: error.message } });
