import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type WorkoutDto } from "@rg/api-client";
import { Banner, formatDayShort, formatMinutes, Sheet, Spinner } from "../components.js";

/** Pick an unmatched activity to complete a workout (manual match). */
export function MatchSheet({
  workout,
  open,
  onClose,
}: {
  workout: WorkoutDto;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const unmatched = useQuery({
    queryKey: ["unmatched-activities"],
    queryFn: api.unmatchedActivities,
    enabled: open,
  });
  const match = useMutation({
    mutationFn: (activityId: string) => api.match(workout.id, activityId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["today"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["garden"] });
      void qc.invalidateQueries({ queryKey: ["unmatched-activities"] });
      onClose();
    },
  });

  return (
    <Sheet open={open} onClose={onClose} title="Match an activity">
      {unmatched.isLoading ? (
        <Spinner />
      ) : (unmatched.data?.activities.length ?? 0) === 0 ? (
        <p className="muted">
          No unmatched activities yet. Completed runs come in from COROS automatically — connect
          COROS in Settings if you haven’t.
        </p>
      ) : (
        <div className="stack">
          {unmatched.data!.activities.map((a) => {
            const id = a.id as string;
            const start = (a.startTimeLocal ?? a.startTime) as string;
            return (
              <button
                key={id}
                className="workout-row"
                disabled={match.isPending}
                onClick={() => match.mutate(id)}
              >
                <div className="body">
                  <div className="title">{(a.title as string) ?? "Run"}</div>
                  <div className="meta">
                    {formatDayShort(start.slice(0, 10))} · {formatMinutes(a.durationSeconds as number)}
                    {a.distanceMeters ? ` · ${((a.distanceMeters as number) / 1000).toFixed(1)} km` : ""}
                  </div>
                </div>
              </button>
            );
          })}
          {match.isError ? <Banner kind="warn">Couldn't match that activity.</Banner> : null}
        </div>
      )}
    </Sheet>
  );
}
