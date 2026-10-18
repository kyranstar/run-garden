/**
 * THE ATHLETE'S MARK ON TODAY'S PICTURE (the new shape, the lead's follow-up to the integrated review's I1): on a phone
 * the mark (Settings, the athlete's initial) sits on its own row above every place — on Today that row cost the card
 * about 60 px of the first screen. So on Today the shell draws no row and hands the mark to the page instead, through
 * this context, and the picture wears it at its top-right corner, as the mock has it. The other places keep the row.
 */
import { createContext, type ReactNode } from "react";

/** The mark the shell hands Today's picture; none elsewhere (and outside the shell). */
export const SceneMarkContext = createContext<ReactNode>(null);
