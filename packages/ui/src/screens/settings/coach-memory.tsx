/**
 * COACH MEMORY — observable and editable (coach UX spec §6; memory v2, Stage 3 Task 10, spec §9). Live for the thread
 * coach too, so it only adds: each item says its kind, how sure it is and where it came from; it can be pinned (the
 * pinned core rides in every coach run, at most 12), and the coach's inference confirmed; what a newer item replaced
 * is one tap down under it. Edit and delete work as they always have: deleting is immediate and total — the next
 * dossier simply lacks the item.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CoachMemoryItem } from "@rg/api-client";
import { Card, formatShortDate } from "../../components.js";
import { confidenceWords, groupItems, historyOf, MEMORY_GROUPS, metaLine, PIN_CAP_LINE } from "./coach-memory-model.js";

/** One item: its words, what it is, its actions, and the versions it replaced (collapsed). */
export function MemoryItem({
  item,
  history,
  editing,
  draft,
  busy = false,
  onDraft,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  onPin,
  onConfirm,
}: {
  item: CoachMemoryItem;
  history: readonly CoachMemoryItem[];
  editing: boolean;
  draft: string;
  busy?: boolean;
  onDraft: (v: string) => void;
  onSave: (body: string) => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: (pinned: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="memory-item">
      <div className="memory-row">
        {editing ? (
          <input
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            aria-label="Edit memory"
            className="memory-edit"
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) onSave(draft.trim());
              if (e.key === "Escape") onCancel();
            }}
          />
        ) : (
          <span className="memory-body">{item.body}</span>
        )}
        <span className="row memory-actions">
          {item.confidence === "inferred" ? (
            <button type="button" className="linklike" disabled={busy} onClick={onConfirm}>
              Confirm
            </button>
          ) : null}
          <button type="button" className="linklike" disabled={busy} aria-pressed={item.pinned === true} onClick={() => onPin(!item.pinned)}>
            {item.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" className="linklike" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="linklike" onClick={onDelete}>
            Delete
          </button>
        </span>
      </div>
      <p className="memory-meta faint">{metaLine(item)}</p>
      {history.length > 0 ? (
        <details className="memory-history">
          <summary className="tap-pad">Earlier versions ({history.length})</summary>
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                {h.body}
                <span className="faint">
                  {" "}
                  · {confidenceWords(h)}, {formatShortDate(h.learnedAt.slice(0, 10))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** The list's groups, each item with its history. */
export function MemoryList({
  memory,
  history,
  render,
}: {
  memory: readonly CoachMemoryItem[];
  history: readonly CoachMemoryItem[];
  render: (item: CoachMemoryItem, history: CoachMemoryItem[]) => ReactNode;
}) {
  return (
    <>
      {MEMORY_GROUPS.map(({ kind, label }) => {
        const group = groupItems(memory, kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} className="memory-group">
            <h3 className="card-title">{label}</h3>
            {group.map((m) => (
              <div key={m.id}>{render(m, historyOf(m.id, history))}</div>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function CoachMemorySection() {
  const qc = useQueryClient();
  const memory = useQuery({ queryKey: ["coach-memory"], queryFn: api.coachMemoryList });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["coach-memory"] });
    void qc.invalidateQueries({ queryKey: ["coach-state"] });
  };
  const update = useMutation({
    mutationFn: (v: { id: string; body: string }) => api.coachMemoryUpdate(v.id, v.body),
    onSettled: invalidate,
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; patch: { pinned?: boolean; confirm?: true } }) => api.coachMemoryPatch(v.id, v.patch),
    onSuccess: () => setRefusal(null),
    onError: (e) => {
      const why = e instanceof ApiError && e.status === 409 ? (e.body as { why?: unknown } | null)?.why : null;
      setRefusal(typeof why === "string" ? why : e instanceof ApiError && e.status === 409 ? PIN_CAP_LINE : "Couldn't save that — try again.");
    },
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.coachMemoryDelete(id),
    onSettled: invalidate,
  });
  const rows = memory.data?.memory ?? [];
  const history = memory.data?.history ?? [];
  return (
    <div id="coach-memory">
      <Card title="Coach memory">
        <p className="muted">
          Everything the coach knows about you — learned from your messages, editable here,
          deleted for good the moment you say so.
        </p>
        {rows.length === 0 ? (
          <p className="faint">Nothing yet — the coach learns as you talk to it.</p>
        ) : (
          <MemoryList
            memory={rows}
            history={history}
            render={(m, versions) => (
              <MemoryItem
                item={m}
                history={versions}
                editing={editing === m.id}
                draft={draft}
                busy={patch.isPending && patch.variables?.id === m.id}
                onDraft={setDraft}
                onSave={(body) => {
                  update.mutate({ id: m.id, body });
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
                onEdit={() => {
                  setEditing(m.id);
                  setDraft(m.body);
                }}
                onDelete={() => remove.mutate(m.id)}
                onPin={(pinned) => patch.mutate({ id: m.id, patch: { pinned } })}
                onConfirm={() => patch.mutate({ id: m.id, patch: { confirm: true } })}
              />
            )}
          />
        )}
        {refusal ? (
          <p className="memory-refusal" role="status">
            {refusal}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
