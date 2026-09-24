(function () {
'use strict';

const SIZE = 16;
const DIRECTIONS = {
  up: { x:0, y:-1 }, right: { x:1, y:0 },
  down: { x:0, y:1 }, left: { x:-1, y:0 },
};
const ORDER = ['up', 'right', 'down', 'left'];
const OPPOSITE = { up:'down', right:'left', down:'up', left:'right' };

function same(a, b) { return a.x === b.x && a.y === b.y; }
function nextHead(head, direction) { const delta = DIRECTIONS[direction]; return { x:head.x + delta.x, y:head.y + delta.y }; }
function inBounds(cell) { return cell.x >= 0 && cell.x < SIZE && cell.y >= 0 && cell.y < SIZE; }

function chooseFood(snake, random = Math.random) {
  const open = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const cell = { x, y };
    if (!snake.some(segment => same(segment, cell))) open.push(cell);
  }
  if (!open.length) return null;
  return open[Math.min(open.length - 1, Math.floor(random() * open.length))];
}

function initialState(random = Math.random) {
  const snake = [{ x:8, y:8 }, { x:7, y:8 }, { x:6, y:8 }];
  return { snake, direction:'right', food:chooseFood(snake, random), score:0, steps:0, over:false, won:false };
}

function legalMoves(state) {
  if (state.over || state.won) return [];
  return ORDER.filter(direction => {
    if (state.snake.length > 1 && direction === OPPOSITE[state.direction]) return false;
    const head = nextHead(state.snake[0], direction);
    if (!inBounds(head)) return false;
    const eating = state.food && same(head, state.food);
    const blocking = eating ? state.snake : state.snake.slice(0, -1);
    return !blocking.some(segment => same(segment, head));
  });
}

function movedSnake(state, direction) {
  const head = nextHead(state.snake[0], direction);
  const eating = !!state.food && same(head, state.food);
  const snake = [head, ...state.snake];
  if (!eating) snake.pop();
  return { head, snake, eating };
}

function advance(state, direction, random = Math.random) {
  if (!legalMoves(state).includes(direction)) throw new Error(`非法方向 ${direction}`);
  const result = movedSnake(state, direction);
  const won = result.snake.length === SIZE * SIZE;
  return {
    snake:result.snake, direction,
    food:result.eating ? (won ? null : chooseFood(result.snake, random)) : state.food,
    score:state.score + (result.eating ? 1 : 0), steps:state.steps + 1,
    over:false, won,
  };
}

function floodAndDistance(snake, food) {
  const blocked = new Set(snake.slice(1).map(cell => `${cell.x},${cell.y}`));
  const queue = [{ ...snake[0], distance:0 }];
  const seen = new Set([`${snake[0].x},${snake[0].y}`]);
  let foodDistance = food && same(snake[0], food) ? 0 : null;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const direction of ORDER) {
      const cell = nextHead(current, direction);
      const key = `${cell.x},${cell.y}`;
      if (!inBounds(cell) || blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      const distance = current.distance + 1;
      if (food && same(cell, food)) foodDistance = distance;
      queue.push({ ...cell, distance });
    }
  }
  return { reachableCells:seen.size, foodDistance };
}

function analyzeMoves(state) {
  return legalMoves(state).map(direction => {
    const { head, snake, eating } = movedSnake(state, direction);
    const metrics = floodAndDistance(snake, eating ? null : state.food);
    return { direction, head, eating, snake, ...metrics };
  });
}

function decisionOptions(state) {
  const options = analyzeMoves(state);
  if (!options.length) return [];
  const safe = options.filter(option => option.reachableCells >= state.snake.length + 1);
  const pool = safe.length ? safe : options;
  const eating = pool.filter(option => option.eating);
  if (eating.length) return eating;
  const reachableFood = pool.filter(option => option.foodDistance !== null);
  if (reachableFood.length) {
    const shortest = Math.min(...reachableFood.map(option => option.foodDistance));
    return reachableFood.filter(option => option.foodDistance === shortest);
  }
  const largest = Math.max(...pool.map(option => option.reachableCells));
  return pool.filter(option => option.reachableCells === largest);
}

function boardText(state) {
  const rows = Array.from({ length:SIZE }, () => Array(SIZE).fill('.'));
  if (state.food) rows[state.food.y][state.food.x] = 'F';
  for (const segment of state.snake.slice(1)) rows[segment.y][segment.x] = 'o';
  rows[state.snake[0].y][state.snake[0].x] = 'H';
  return rows.map(row => row.join('')).join('/');
}

function buildDecisionRequest(state, options) {
  if (!options.length) throw new Error('没有合法方向');
  return {
    model:'english',
    state:`Snake ${SIZE}x${SIZE}. Head (${state.snake[0].x},${state.snake[0].y}); body head-to-tail ${state.snake.map(c => `(${c.x},${c.y})`).join(' ')}; current direction ${state.direction}; food (${state.food.x},${state.food.y}). Board top to bottom: H=head, o=body, F=food, .=empty: ${boardText(state)}.`,
    questions:{
      move:{ type:'choice',
        instructions:'Choose the safest next direction. Eat the food while keeping enough open space to survive. Avoid traps; a short path to food is good only when safe.',
        criteria:Object.fromEntries(options.map(option => [option.direction,
          `next head (${option.head.x},${option.head.y}); eats food ${option.eating ? 'yes' : 'no'}; reachable cells ${option.reachableCells}; food distance ${option.foodDistance ?? 'unreachable'}`])),
      },
    },
  };
}

function readChoice(response, options) {
  const answer = response?.answers?.move;
  const direction = answer?.choice ?? answer?.value ?? answer?.label;
  const option = options.find(item => item.direction === direction);
  if (!option) throw new Error(`SystemOne 返回未知方向：${String(direction)}`);
  return option;
}

function decisionProbabilities(response, options) {
  const reported = response?.answers?.move?.probabilities ?? {};
  return Object.fromEntries(options.map(option => [option.direction,
    typeof reported[option.direction] === 'number' ? reported[option.direction] : 0]));
}

const SnakeCore = { SIZE, initialState, legalMoves, advance, analyzeMoves, boardText,
  decisionOptions, buildDecisionRequest, readChoice, decisionProbabilities };
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeCore;
if (typeof window !== 'undefined') window.SnakeCore = SnakeCore;
})();
