/**
 * THE COACH'S WORDS AS THE CONVERSATION DRAWS THEM (`paragraphs`). Prod 2026-11-04: an answer in bullets — "a few
 * things need sorting:" then "- **Today's hinge session:** …" — read as raw markdown. Blank lines part paragraphs; a
 * paragraph of "- " lines is a list, and a lead-in line straight above one keeps its place; `**words**` is strong. Only
 * React elements: nothing the model writes becomes HTML.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { paragraphs } from "../src/screens/studio/coach-conversation.js";

const html = (text: string) => renderToStaticMarkup(<div>{paragraphs(text)}</div>);

describe("the coach's words", () => {
  it("paragraphs stay paragraphs", () => {
    expect(html("One.\n\nTwo.")).toBe("<div><p>One.</p><p>Two.</p></div>");
  });

  it("a lead-in line and its bullets: the line, then a list, bold as strong", () => {
    const out = html("Most of your plan is fine:\n\n- **Today's session:** well built.\n- **Tue 10 Nov:** good as it is.");
    expect(out).toBe(
      '<div><p>Most of your plan is fine:</p><ul class="coach-said-list"><li><strong>Today&#x27;s session:</strong> well built.</li><li><strong>Tue 10 Nov:</strong> good as it is.</li></ul></div>',
    );
    expect(html("A few things:\n- one\n- two")).toBe('<div><p>A few things:</p><ul class="coach-said-list"><li>one</li><li>two</li></ul></div>');
  });

  it("never HTML: a tag the model writes is text", () => {
    expect(html("**<b>x</b>** <script>y</script>")).toBe("<div><p><strong>&lt;b&gt;x&lt;/b&gt;</strong> &lt;script&gt;y&lt;/script&gt;</p></div>");
  });

  it("a dash inside a sentence is not a list", () => {
    expect(html("Easy legs - then rest.")).toBe("<div><p>Easy legs - then rest.</p></div>");
  });
});
