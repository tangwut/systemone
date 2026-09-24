import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import core from '../core.js';

const { emptyBoard, enumerateCandidates, executeCommands, buildDecisionRequest, readChoice, decisionProbabilities } = core;

test('plain file scripts expose the game core and direct API configuration', () => {
  const context = createContext({ window: {} });
  runInContext(readFileSync(new URL('../core.js', import.meta.url), 'utf8'), context);
  runInContext(readFileSync(new URL('../../config.example.js', import.meta.url), 'utf8'), context);
  runInContext('const { WIDTH, HEIGHT, PIECES } = window.TetrisCore;', context);
  assert.equal(typeof context.window.TetrisCore.enumerateCandidates, 'function');
  assert.equal(context.window.SYSTEMONE_API_KEY, '');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\(API_URL/);
  assert.match(html, /Authorization:\s*`Bearer \$\{API_KEY\}`/);
  assert.match(html, /http:\/\/127\.0\.0\.1:8000\/api\/v1\/systemone/);
  assert.doesNotMatch(html, /type="module"/);
});

test('start button initializes the board and sends an authenticated API request', () => {
  const elements = new Map();
  const fakeElement = () => ({
    textContent: '', value: '300', style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    append() {}, prepend() {}, replaceChildren() {},
    getContext() { return { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }; },
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, fakeElement()); return elements.get(id); },
    createElement: fakeElement,
  };
  let request;
  const context = createContext({
    window: { TetrisCore: core, SYSTEMONE_API_KEY: 'test-key' },
    document, performance: { now: () => 1 },
    fetch(url, options) { request = { url, options }; return new Promise(() => {}); },
  });
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline, 'game script should be present');
  runInContext(inline, context);
  assert.notEqual(elements.get('next').textContent, '—');
  elements.get('start').onclick();
  assert.match(elements.get('status').textContent, /SystemOne 正在/);
  assert.equal(request.url, 'http://127.0.0.1:8000/api/v1/systemone');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
});

test('each candidate is a legal placement reached by its commands', () => {
  const board = emptyBoard();
  const candidates = enumerateCandidates(board, 'T', 'I');
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    const result = executeCommands(board, 'T', candidate.commands);
    assert.deepEqual(result.board, candidate.board);
    assert.equal(result.lines, candidate.lines);
    assert.equal(result.x, candidate.x);
    assert.equal(result.rotation, candidate.rotation);
  }
});

test('a completed row is cleared and changes the candidate outcome', () => {
  const board = emptyBoard();
  board[19] = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
  const candidate = enumerateCandidates(board, 'I').find(c => c.lines === 1);
  assert.ok(candidate, 'horizontal I should complete the bottom row');
  assert.deepEqual(candidate.board[19], Array(10).fill(0));
});

test('shortlist keeps a line-clearing placement ahead of non-clearing choices', () => {
  const board = emptyBoard();
  board[19] = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
  const candidates = enumerateCandidates(board, 'I', 'T');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].lines, 1);
});

test('decision request uses valid choice labels and response selects only offered labels', () => {
  const candidates = enumerateCandidates(emptyBoard(), 'T');
  const request = buildDecisionRequest(emptyBoard(), 'T', candidates, 'I');
  assert.equal(request.questions.placement.type, 'choice');
  assert.equal(Object.keys(request.questions.placement.criteria).length, candidates.length);
  assert.match(request.state, /current shape/i);
  assert.match(request.state, /next shape/i);
  assert.match(request.questions.placement.criteria[candidates[0].id], /board after placement/i);
  assert.match(request.questions.placement.criteria[candidates[0].id], /landing row/i);
  assert.match(request.questions.placement.criteria[candidates[0].id], /rotated shape/i);
  assert.equal(readChoice({ answers: { placement: { choice: candidates[0].id } } }, candidates), candidates[0]);
  assert.throws(() => readChoice({ answers: { placement: { choice: 'unknown' } } }, candidates), /未知落点/);
});

test('model probabilities stay associated with candidate labels for visualization', () => {
  const candidates = enumerateCandidates(emptyBoard(), 'T');
  const values = decisionProbabilities({ answers: { placement: { probabilities: { [candidates[1].id]: 0.8 } } } }, candidates);
  assert.equal(values[candidates[1].id], 0.8);
  assert.equal(values[candidates[0].id], 0);
});
