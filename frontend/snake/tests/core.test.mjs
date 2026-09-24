import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import core from '../core.js';

const { SIZE, initialState, legalMoves, advance, analyzeMoves, decisionOptions, buildDecisionRequest, readChoice } = core;

test('moving into a wall, reversing, or hitting the body is excluded', () => {
  const wall = { snake:[{x:0,y:0},{x:0,y:1},{x:0,y:2}], direction:'up', food:{x:5,y:5}, score:0, steps:0 };
  assert.deepEqual(legalMoves(wall), ['right']);
  const bent = { snake:[{x:3,y:3},{x:3,y:4},{x:2,y:4},{x:2,y:3}], direction:'up', food:{x:5,y:5}, score:0, steps:0 };
  assert.deepEqual(legalMoves(bent), ['up', 'right', 'left']);
});

test('moving into the vacating tail is legal unless food is there', () => {
  const state = { snake:[{x:2,y:2},{x:2,y:3},{x:1,y:3},{x:1,y:2}], direction:'up', food:{x:8,y:8}, score:0, steps:0 };
  assert.ok(legalMoves(state).includes('left'));
  assert.ok(!legalMoves({ ...state, food:{x:1,y:2} }).includes('left'));
});

test('one step moves the head and eating grows the snake without placing food on its body', () => {
  const state = initialState(() => 0.8);
  assert.equal(state.snake.length, 3);
  const food = { x:state.snake[0].x + 1, y:state.snake[0].y };
  const eaten = advance({ ...state, food }, 'right', () => 0);
  assert.equal(eaten.snake.length, 4);
  assert.equal(eaten.score, 1);
  assert.ok(!eaten.snake.some(cell => cell.x === eaten.food.x && cell.y === eaten.food.y));
  const moved = advance(eaten, 'up', () => 0);
  assert.equal(moved.snake.length, 4);
  assert.equal(moved.steps, 2);
});

test('request exposes board, shape and safe direction outcomes to SystemOne', () => {
  const state = initialState(() => 0.8);
  const options = analyzeMoves(state);
  const request = buildDecisionRequest(state, options);
  assert.equal(request.questions.move.type, 'choice');
  assert.deepEqual(Object.keys(request.questions.move.criteria), options.map(option => option.direction));
  assert.match(request.state, /board/i);
  assert.match(request.state, /food/i);
  assert.match(request.questions.move.criteria[options[0].direction], /reachable cells/i);
  assert.equal(readChoice({ answers:{ move:{ choice:options[0].direction } } }, options), options[0]);
  assert.throws(() => readChoice({ answers:{ move:{ choice:'invalid' } } }, options), /未知方向/);
});

test('safe move toward adjacent food is the only direction offered', () => {
  const state = initialState(() => 0.8);
  state.food = { x:state.snake[0].x + 1, y:state.snake[0].y };
  assert.deepEqual(decisionOptions(state).map(option => option.direction), ['right']);
});

test('snake page starts and sends an authenticated direct API request', () => {
  const elements = new Map();
  const fakeElement = () => ({ textContent:'', value:'250', style:{},
    classList:{ add() {}, remove() {}, toggle() {} }, append() {}, prepend() {}, replaceChildren() {},
    getContext() { return { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} }; },
  });
  const context = createContext({
    window:{ SYSTEMONE_API_KEY:'test-key' },
    document:{ getElementById(id) { if (!elements.has(id)) elements.set(id, fakeElement()); return elements.get(id); }, createElement:fakeElement },
    performance:{ now:() => 1 },
    fetch(url, options) { context.request = {url, options}; return new Promise(() => {}); },
  });
  runInContext(readFileSync(new URL('../core.js', import.meta.url), 'utf8'), context);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline);
  runInContext(inline, context);
  elements.get('start').onclick();
  assert.match(elements.get('status').textContent, /SystemOne 正在/);
  assert.equal(context.request.url, 'http://127.0.0.1:8000/api/v1/systemone');
  assert.equal(context.request.options.headers.Authorization, 'Bearer test-key');
});
