(function () {
'use strict';

const WIDTH = 10;
const HEIGHT = 20;

const SHAPES = {
  I: [[0, 0], [1, 0], [2, 0], [3, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T: [[0, 0], [1, 0], [2, 0], [1, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
};

const PIECES = Object.keys(SHAPES);
const emptyBoard = () => Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(0));

function normalize(cells) {
  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  return cells.map(([x, y]) => [x - minX, y - minY]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function rotations(type) {
  if (!SHAPES[type]) throw new Error(`未知方块 ${type}`);
  const result = [];
  let cells = SHAPES[type];
  for (let i = 0; i < 4; i++) {
    const normalized = normalize(cells);
    if (!result.some(old => JSON.stringify(old) === JSON.stringify(normalized))) result.push(normalized);
    cells = cells.map(([x, y]) => [-y, x]);
  }
  return result;
}

function canPlace(board, cells, x, y) {
  return cells.every(([dx, dy]) => {
    const col = x + dx, row = y + dy;
    return col >= 0 && col < WIDTH && row >= 0 && row < HEIGHT && !board[row][col];
  });
}

function land(board, cells, x) {
  if (!canPlace(board, cells, x, 0)) return null;
  let y = 0;
  while (canPlace(board, cells, x, y + 1)) y++;
  return y;
}

function lock(board, cells, x, y) {
  const next = board.map(row => [...row]);
  for (const [dx, dy] of cells) next[y + dy][x + dx] = 1;
  const kept = next.filter(row => row.some(cell => !cell));
  const lines = HEIGHT - kept.length;
  return { board: [...Array.from({ length: lines }, () => Array(WIDTH).fill(0)), ...kept], lines };
}

function reachable(board, type) {
  const variants = rotations(type);
  const start = { rotation: 0, x: 3, commands: [] };
  if (!canPlace(board, variants[0], start.x, 0)) return [];
  const queue = [start], seen = new Set(['0:3']);
  for (let i = 0; i < queue.length; i++) {
    const state = queue[i];
    for (const [command, rotation, x] of [
      ['left', state.rotation, state.x - 1],
      ['right', state.rotation, state.x + 1],
      ['rotate', (state.rotation + 1) % variants.length, state.x],
    ]) {
      const key = `${rotation}:${x}`;
      if (seen.has(key) || !canPlace(board, variants[rotation], x, 0)) continue;
      seen.add(key);
      queue.push({ rotation, x, commands: [...state.commands, command] });
    }
  }
  return queue;
}

function metrics(board) {
  const heights = [];
  let holes = 0;
  for (let x = 0; x < WIDTH; x++) {
    let filled = false, height = 0;
    for (let y = 0; y < HEIGHT; y++) {
      if (board[y][x]) {
        if (!filled) height = HEIGHT - y;
        filled = true;
      } else if (filled) holes++;
    }
    heights.push(height);
  }
  const bumpiness = heights.slice(1).reduce((sum, value, i) => sum + Math.abs(value - heights[i]), 0);
  return { height: Math.max(...heights), aggregateHeight: heights.reduce((a, b) => a + b, 0), holes, bumpiness };
}

function allCandidates(board, type) {
  const variants = rotations(type);
  const options = [];
  for (const state of reachable(board, type)) {
    const cells = variants[state.rotation];
    const y = land(board, cells, state.x);
    if (y === null) continue;
    const result = lock(board, cells, state.x, y);
    const m = metrics(result.board);
    const rank = result.lines * 20 - m.holes * 6 - m.height - m.aggregateHeight * 0.25 - m.bumpiness * 0.4;
    options.push({ ...state, y, cells, ...result, ...m, rank, commands: [...state.commands, 'hard_drop'] });
  }
  return options;
}

function enumerateCandidates(board, type, nextType = null) {
  const options = allCandidates(board, type);
  if (nextType) for (const option of options) {
    const following = allCandidates(option.board, nextType);
    const best = following.reduce((winner, item) => !winner || item.rank > winner.rank ? item : winner, null);
    option.nextLines = best?.lines ?? 0;
    option.rank += best ? best.rank * 0.45 : -100;
  }
  options.sort((a, b) => b.rank - a.rank || a.rotation - b.rotation || a.x - b.x);
  const count = options.length > 1 && options[0].rank - options[1].rank > 2.5 ? 1 : 2;
  return options.slice(0, count).map((option, i) => ({ ...option, id: `C${String(i + 1).padStart(2, '0')}` }));
}

function executeCommands(board, type, commands) {
  const variants = rotations(type);
  let rotation = 0, x = 3;
  if (!canPlace(board, variants[rotation], x, 0)) throw new Error('新方块无法生成');
  for (const command of commands) {
    if (command === 'hard_drop') {
      const y = land(board, variants[rotation], x);
      return { ...lock(board, variants[rotation], x, y), x, y, rotation };
    }
    const nextRotation = command === 'rotate' ? (rotation + 1) % variants.length : rotation;
    const nextX = x + (command === 'left' ? -1 : command === 'right' ? 1 : 0);
    if (!['rotate', 'left', 'right'].includes(command) || !canPlace(board, variants[nextRotation], nextX, 0)) {
      throw new Error(`非法指令 ${command}`);
    }
    rotation = nextRotation;
    x = nextX;
  }
  throw new Error('缺少 hard_drop 指令');
}

function boardText(board) {
  const firstFilled = board.findIndex(row => row.some(Boolean));
  if (firstFilled < 0) return 'empty';
  return `rows ${firstFilled}-${HEIGHT - 1}: ` + board.slice(firstFilled).map(row => row.map(cell => cell ? '#' : '.').join('')).join('/');
}

function cellsText(cells) {
  const width = Math.max(...cells.map(([x]) => x)) + 1;
  const height = Math.max(...cells.map(([, y]) => y)) + 1;
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) =>
    cells.some(([cx, cy]) => cx === x && cy === y) ? '#' : '.').join('')).join('/');
}

function shapeText(type) {
  return type ? cellsText(rotations(type)[0]) : 'unknown';
}

function buildDecisionRequest(board, type, candidates, nextType = null) {
  if (!candidates.length) throw new Error('没有合法落点');
  return {
    model: 'english',
    state: `Tetris 10x20. Current piece ${type}; current shape ${shapeText(type)}; next piece ${nextType ?? 'unknown'}; next shape ${shapeText(nextType)}. Current board top to bottom (# filled, . empty): ${boardText(board)}.`,
    questions: {
      placement: {
        type: 'choice',
        instructions: 'Compare the board after each placement. Choose the move that survives longer: clear lines, avoid buried holes and tall stacks. Return one candidate label.',
        criteria: Object.fromEntries(candidates.map(c => [c.id,
          `rotation ${c.rotation}; rotated shape ${cellsText(c.cells)}; column ${c.x}; landing row ${c.y}; clears ${c.lines} lines; holes ${c.holes}; height ${c.height}; next piece can clear ${c.nextLines ?? 0} lines; board after placement: ${boardText(c.board)}`])),
      },
    },
  };
}

function readChoice(response, candidates) {
  const answer = response?.answers?.placement;
  const label = answer?.choice ?? answer?.value ?? answer?.label;
  const candidate = candidates.find(c => c.id === label);
  if (!candidate) throw new Error(`SystemOne 返回未知落点：${String(label)}`);
  return candidate;
}

function decisionProbabilities(response, candidates) {
  const reported = response?.answers?.placement?.probabilities ?? {};
  return Object.fromEntries(candidates.map(candidate => {
    const value = reported[candidate.id];
    return [candidate.id, typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0];
  }));
}

const TetrisCore = { WIDTH, HEIGHT, PIECES, emptyBoard, rotations, canPlace,
  enumerateCandidates, executeCommands, buildDecisionRequest, readChoice, decisionProbabilities };
if (typeof module !== 'undefined' && module.exports) module.exports = TetrisCore;
if (typeof window !== 'undefined') window.TetrisCore = TetrisCore;
})();
