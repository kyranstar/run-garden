/**
 * THE WAY INTO THE BUILDER from the Studio's home (spec §3: "[ New workout ]"): "New workout" — or, while a workout is
 * being built on this device, "Continue “Hips & posture”" (the builder's Save menu starts a new one over it). A link,
 * so it can open in a new tab and needs nothing to be loaded first.
 */
import { Link } from "react-router-dom";
import { useStudioDraft } from "../../studio-drafts.js";
import { IconPlus } from "../../icons.js";

export const BUILD_NEW_HREF = "/studio/build/new";

export function BuildEntry() {
  const { draft } = useStudioDraft();
  return (
    <div className="stu-build-entry">
      <Link className="btn btn-primary btn-wrap stu-build-entry-btn" to={BUILD_NEW_HREF}>
        {draft ? (
          `Continue “${draft.doc.title}”`
        ) : (
          <>
            <IconPlus size={16} />
            New workout
          </>
        )}
      </Link>
    </div>
  );
}
