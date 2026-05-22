import assert from "node:assert";
import { test } from "node:test";
import { StreamingToolParser } from "../tools/parser.ts";

test("StreamingToolParser: basic tool call", () => {
	const parser = new StreamingToolParser();
	const chunk1 =
		'Hello! <tool_call>{"name": "test_tool", "arguments": {"foo": "bar"}}</tool_call>';
	const result = parser.feed(chunk1);

	assert.strictEqual(result.text, "Hello! ");
	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "test_tool");
	assert.deepStrictEqual(result.toolCalls[0].arguments, { foo: "bar" });
});

test("StreamingToolParser: fragmented tool call", () => {
	const parser = new StreamingToolParser();

	const res1 = parser.feed("Some text <tool_");
	assert.strictEqual(res1.text, "Some text ");
	assert.strictEqual(res1.toolCalls.length, 0);

	const res2 = parser.feed('call>{"name": "fragmented", "arg');
	assert.strictEqual(res2.text, "");
	assert.strictEqual(res2.toolCalls.length, 0);

	const res3 = parser.feed('uments": {"ok": true}}</tool_call> Trailing text');
	assert.strictEqual(res3.text, "");
	assert.strictEqual(res3.toolCalls.length, 1);
	assert.strictEqual(res3.toolCalls[0].name, "fragmented");
	assert.deepStrictEqual(res3.toolCalls[0].arguments, { ok: true });
});

test("StreamingToolParser: multiple tool calls", () => {
	const parser = new StreamingToolParser();
	const chunk =
		'<tool_call>{"name": "t1", "arguments": {}}</tool_call><tool_call>{"name": "t2", "arguments": {}}</tool_call>';
	const result = parser.feed(chunk);

	assert.strictEqual(result.text, "");
	assert.strictEqual(result.toolCalls.length, 2);
	assert.strictEqual(result.toolCalls[0].name, "t1");
	assert.strictEqual(result.toolCalls[1].name, "t2");
});

test("StreamingToolParser: flush partial content", () => {
	const parser = new StreamingToolParser();
	const res1 = parser.feed("Unfinished text <tool_");
	assert.strictEqual(res1.text, "Unfinished text ");

	const res2 = parser.flush();
	assert.strictEqual(res2.text, "<tool_");
	assert.strictEqual(res2.toolCalls.length, 0);
});

test("StreamingToolParser: robust parsing in stream", () => {
	const parser = new StreamingToolParser();
	const result = parser.feed(
		'<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>',
	);

	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "broken");
	assert.deepStrictEqual(result.toolCalls[0].arguments, { a: 1 });
});

test("StreamingToolParser: parses Bengali tool delimiters", () => {
	const parser = new StreamingToolParser();
	const result = parser.feed('তত\n{"name":"session_search","arguments":{"query":"usagi OR brettchalupa"}}✨');

	assert.strictEqual(result.text, "");
	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "session_search");
	assert.deepStrictEqual(result.toolCalls[0].arguments, { query: "usagi OR brettchalupa" });
});

test("StreamingToolParser: buffers partial Bengali delimiter without leaking raw tool text", () => {
	const parser = new StreamingToolParser();

	const res1 = parser.feed("ত");
	assert.strictEqual(res1.text, "");
	assert.strictEqual(res1.toolCalls.length, 0);

	const res2 = parser.feed('তত\n{"name":"session_search","arguments":{"query":"usagi"}}✨');
	assert.strictEqual(res2.text, "");
	assert.strictEqual(res2.toolCalls.length, 1);
	assert.strictEqual(res2.toolCalls[0].name, "session_search");
});
