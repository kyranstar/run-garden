/**
 * COACH MEMORY — observable and editable (coach UX spec §6; memory v2, Stage 3 Task 10, spec §9). Live for the thread
 * coach too, so it only adds: each item says its kind, how sure it is and where it came from; it can be pinned (the
 * pinned core rides in every coach run, at most 12), and the coach's inference confirmed; what a newer item replaced
 * is one tap down under it. Edit and delete send what they always have: deleting is total — the next dossier simply
 * lacks the item — so it asks first, inline on the item: "Delete for good?" Yes · No (fix wave 3B, M9).
 */
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CoachMemoryItem } from "@rg/api-client";
import { Card, CardLevelContext, formatShortDate } from "../../components.js";
import { confidenceWords, DELETE_ASK, groupItems, historyOf, MEMORY_CAPTION, MEMORY_GROUPS, metaLine, PIN_CAP_LINE } from "./coach-memory-model.js";

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
  // Delete asks first, inline, in the place of this item's actions (fix wave 3B, M9): "Delete for good?" Yes · No.
  const [asking, setAsking] = useState(false);
  const no = useRef<HTMLButtonElement>(null);
  const del = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    // The focus follows the question in, and back to Delete when it is answered No.
    if (asking) no.current?.focus();
    else if (wasAsking.current) del.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  return (
    <div className="memory-item">
      <div className="memory-row">
        <div className="memory-main">
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
          <p className="memory-meta faint">{metaLine(item)}</p>
        </div>
        {asking ? (
          <span className="row memory-actions memory-ask" role="group" aria-label={DELETE_ASK}>
            <span className="memory-ask-q">{DELETE_ASK}</span>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setAsking(false);
                wasAsking.current = false;
                onDelete();
              }}
            >
              Yes
            </button>
            <button ref={no} type="button" className="linklike" onClick={() => setAsking(false)}>
              No
            </button>
          </span>
        ) : (
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
            <button ref={del} type="button" className="linklike" onClick={() => setAsking(true)}>
              Delete
            </button>
          </span>
        )}
      </div>
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
  // One level under the card's own title (an h3 in a Settings group: these are h4s), never beside it.
  const Heading = `h${Math.min(6, useContext(CardLevelContext) + 1)}` as "h3" | "h4" | "h5";
  return (
    <>
      {MEMORY_GROUPS.map(({ kind, label }) => {
        const group = groupItems(memory, kind);
        if (group.length === 0) return null;
        return (
          <div key={kind} className="memory-group">
            <Heading className="card-title">{label}</Heading>
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
    // A delete that didn't go through moves no focus later.
    onError: () => setFocusAfter(null),
    onSettled: invalidate,
  });
  const rows = memory.data?.memory ?? [];
  const history = memory.data?.history ?? [];
  // After Yes, the focus goes to the next item's first control — or, the last one gone, to the section's heading —
  // once the list no longer holds the item deleted (the re-review): never dropped with the item it was on.
  const section = useRef<HTMLDivElement>(null);
  const [focusAfter, setFocusAfter] = useState<{ deleted: string; next: number | null } | null>(null);
  useEffect(() => {
    if (!focusAfter || rows.some((m) => m.id === focusAfter.deleted)) return;
    const root = section.current;
    // The item gone, the next one stands where it stood: found by its place in the list, never by an id in the page.
    const next = focusAfter.next !== null ? (root?.querySelectorAll<HTMLElement>(".memory-item")[focusAfter.next] ?? null) : null;
    const target = next?.querySelector<HTMLElement>("button, input") ?? null;
    if (target) target.focus();
    else {
      const heading = root?.querySelector<HTMLElement>("h2, h3");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
    }
    setFocusAfter(null);
  }, [rows, focusAfter]);
  /** The list in the order it shows: the groups', each pinned first, then newest. */
  const order = MEMORY_GROUPS.flatMap(({ kind }) => groupItems(rows, kind).map((m) => m.id));
  return (
    <div id="coach-memory" ref={section}>
      <Card title="Coach memory">
        <p className="muted">{MEMORY_CAPTION}</p>
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
                onDelete={() => {
                  const at = order.indexOf(m.id);
                  // The next item takes this one's place; none there (the last), the heading.
                  setFocusAfter({ deleted: m.id, next: at >= 0 ? at : null });
                  remove.mutate(m.id);
                }}
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
