/**
 * The product name is intentionally referenced from exactly one place so the
 * working name can be replaced later without touching database names, package
 * names, or provider identifiers (which are all brand-neutral).
 */
export const PRODUCT_NAME = "Run Garden";

/** Default name for the dedicated Google Calendar (user can pick another). */
export const DEFAULT_CALENDAR_NAME = PRODUCT_NAME;

/** Key used for private extended properties on managed Google Calendar events. */
export const CALENDAR_EVENT_PROPERTY_NS = "rg";
