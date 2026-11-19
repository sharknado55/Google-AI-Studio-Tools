# AI Studio MCP Bridge

Use MCP servers from Google AI Studio. Every tool call waits for your approval.

## Setup

**1. Start the bridge (only needed for local stdio servers).** Requires Node 18+.

```
cd bridge
cp servers.example.json servers.json   # edit the commands/paths
node bridge.js
```

**2. Load the extension.** Open `chrome://extensions`, turn on Developer mode, choose
Load unpacked, and select the `extension` folder.

**3. Add your servers.** Click the extension's toolbar icon.

- Local server named `files` in `servers.json`: `http://127.0.0.1:3939/mcp/files`
- Remote server: its URL, plus optional `headers` such as an API token

Save (Chrome asks for access to remote addresses), then press Test.

**4. Use it in AI Studio.** Open a chat and click the **MCP** pill at the bottom right,
then **Insert tools, skills and memory**. It adds the tool list, your skills and the
active project's memory to the message box. Add your task and run. For a whole chat,
paste the same text into System instructions instead.

## Mods (v0.2)

Everything below runs in your browser. Nothing extra is sent to Google, no Google
endpoints are called, and nothing is sent without you pressing Run (unless you turn on
auto-send).

- **You press Run.** After you approve a tool call, the result goes into the message box
  and the pill says "press Run". To have the extension press Run for you, turn on
  auto-send in settings (off by default).
- **Tool-result compression.** Results longer than 6,000 characters (you can change this)
  are shortened: JSON is minified, repeated lines are collapsed, and the start, the end
  and error lines are kept. The full text stays in the extension's local storage (the last
  20 results). Gemini reads more with `_meta.retrieve` by search words or by offset.
  This runs without approval because it only reads local data.
- **Compaction.** Use MCP menu > **Compact this chat**. It puts a summary request in the
  box. Press Run. When Gemini replies, a dialog shows the summary. **Open new chat**
  starts a fresh chat with the tools, skills, memory and summary already in the box.
  Press Run to continue.
- **Skills.** In settings, use **Import skill folder** and pick a skill's folder, or a
  parent folder holding many skills. Each folder that has a `SKILL.md` (with a `name:` and
  `description:` header) becomes one skill, with its other text files kept as reference
  files (for example `references/guide.md`). Images and other binary files are skipped.
  Only names and descriptions are inserted. Gemini loads a skill's instructions with
  `_meta.skill` `{"name":"..."}`, which also lists its files, and opens a file with
  `{"name":"...","file":"references/guide.md"}`. Long files come in 20,000-character pages.
- **Project memory.** Facts are stored per project. You edit them in settings and switch
  projects from the MCP menu. Gemini can ask to save a fact with `_meta.remember`, and
  you approve or deny it in the same dialog as a tool call.
- **Faster long chats.** Off-screen messages are skipped when the page draws
  (`content-visibility`). This makes long chats (100k+ tokens) much less laggy. It only
  changes how your browser draws the page. If scrolling jumps oddly, turn it off in
  settings.

## Reliable tool calls (v0.3)

- **Calls are read only from code blocks.** In v0.2 the call was read from the rendered
  page text. When a call was not rendered as a code block, Markdown had already removed
  `_`, `*` and `\`, which broke Luau and other code. Inside a code block the text is
  exact, so the old workarounds (no underscores, no `*`, single-line code, `mul()`
  helpers) are no longer needed. Arguments may also contain real line breaks.
- **Format errors are reported.** A call written as plain text near the end of a reply is
  not run. The extension puts an `MCP FORMAT ERROR` message in the box, telling Gemini to
  resend it on its own lines. An example call in the middle of an explanation is ignored.
- **Up to 5 calls per reply.** Independent calls are approved one after another and the
  results go back in one message.
- **Allowed folders are known up front.** When you insert the tool list, servers that have
  `list_allowed_directories` report their folders in the inserted text, so Gemini does not
  spend a call on it. Set `"promptInfo": ["tool_name"]` on a server in the config to choose
  other info tools, or `[]` for none.
- **Read-only auto-approve (optional).** A settings switch runs tools that the server marks
  `readOnlyHint` without asking. Writes still ask.
- **Allow every tool (optional, risky).** A settings switch skips the approval dialog for
  every call, including writes, deletes, code execution and memory saves. The pill shows
  `MCP (auto)` while it is on. A page or file the model reads could trick it into running
  something harmful. Together with auto-send, the chat runs with no clicks from you, which
  looks most like a bot.

If AI Studio stops showing replies as code blocks with `pre` or `code` elements, update
`SEL.code` at the top of `extension/content.js`.

## Tests

`node test/run.js` starts the bridge with a fake MCP server and checks the worker:
tools, schemas, calls, compression, retrieve, skills and memory. `node test/serve.js`
serves `test/mock.html`, a fake AI Studio page for trying the in-page UI.

## What happens on a tool call

1. Gemini ends its reply with an `mcp-call` block and stops.
2. An overlay shows the tool and its arguments (editable). Nothing runs yet.
3. **Approve** runs it once. **Always allow this tool** skips the prompt for that tool
   from now on (manage the list in settings). **Deny** tells Gemini not to retry.
4. The result is put in the message box. Press Run and Gemini continues (auto-send can do this for you).

## Keeping the tool prompt small

The prompt lists each tool as one short line. Full schemas are not included: Gemini
fetches them when needed with `_meta.describe`, and finds tools with `_meta.search`.
These two lookups run without approval because they execute nothing. If the list would
exceed about 7,500 tokens, the prompt switches to search mode and lists only each
server's tool count plus a few example names. The MCP pill shows the size after inserting.

To trim further, give a server an allow list (and/or a deny list) of tool names, with `*`
wildcards. Hidden tools cannot be called either:

```
{ "name": "rea", "url": "http://127.0.0.1:3939/mcp/rea",
  "tools": ["analyze_javascript*", "*electron*"], "hideTools": ["*capture*"] }
```

## Limits to know about

- Not tested against the live AI Studio page. It finds replies and the message box with
  the selectors at the top of `extension/content.js`; adjust them if AI Studio changes.
- Calling is prompt-based, not AI Studio's built-in function calling, so the model
  has to follow the format. Gemini does not freeze mid-reply: it finishes its turn with
  the call and nothing continues until you approve.
- Remote servers must support Streamable HTTP. Servers that need OAuth or only offer the
  old `/sse` transport can be run through the bridge with `npx mcp-remote <url>` as the command.
- Tool results go to Google as part of your chat. Only allow-list tools that are safe to read from.
- The bridge only accepts requests from the extension; it does not listen beyond `127.0.0.1`.
