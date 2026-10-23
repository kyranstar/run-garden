import type { SaveErrorCode } from "@rg/saves";

// What can go wrong in a check, each carrying the code the app's check report records. Messages are plain words: they
// never carry the token (it is not in any URL or message), and they are cut to the report's 200 characters.

export class CheckError extends Error {
  constructor(
    readonly code: SaveErrorCode,
    message: string,
  ) {
    super(message.slice(0, 200));
    this.name = new.target.name;
  }
}

/** The site's session expired: a 401/403, a redirect to its login page, or a login page instead of data. */
export class LoginNeededError extends CheckError {
  constructor(message = "Instagram wants you to log in again") {
    super("login_needed", message);
  }
}

/** The feed's shape is not what the parser knows. Nothing from that read is used. */
export class FeedChangedError extends CheckError {
  constructor(message = "Instagram changed something — the extension needs an update") {
    super("feed_changed", message);
  }
}

/** A single post the site no longer has. */
export class PostGoneError extends CheckError {
  constructor(message = "A saved post is gone") {
    super("gone", message);
  }
}

/** The site answered something else (a rate limit, its own outage, a broken page). */
export class ReaderError extends CheckError {
  constructor(message: string) {
    super("unknown", message);
  }
}

/** A media download failed (most often an expired signed link). */
export class MediaError extends CheckError {
  constructor(message: string) {
    super("media_failed", message);
  }
}

/** The app could not be reached, or answered with an outage (5xx, a gateway page). The work waits in the queue. */
export class AppUnreachableError extends CheckError {
  constructor(message = "App unreachable") {
    super("app_unreachable", message);
  }
}

/** The app said no for good: a wrong token (401), the import switched off (404), or a request it found invalid (4xx). */
export class AppRefusedError extends CheckError {
  constructor(
    readonly status: number,
    readonly error: string | null,
  ) {
    super("unknown", status === 401 ? "The app refused the token" : status === 404 ? "The app's saves import is off" : `The app refused a request (${status}${error ? ` ${error}` : ""})`);
  }
}
