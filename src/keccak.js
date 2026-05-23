const MASK_64 = (1n << 64n) - 1n;
const RATE_BYTES_256 = 136;

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

const ROTATION_OFFSETS = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n
];

export function keccak256(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const state = Array(25).fill(0n);
  let offset = 0;

  while (offset + RATE_BYTES_256 <= bytes.length) {
    absorbBlock(state, bytes.subarray(offset, offset + RATE_BYTES_256));
    keccakF1600(state);
    offset += RATE_BYTES_256;
  }

  const finalBlock = Buffer.alloc(RATE_BYTES_256);
  bytes.copy(finalBlock, 0, offset);
  finalBlock[bytes.length - offset] ^= 0x01;
  finalBlock[RATE_BYTES_256 - 1] ^= 0x80;
  absorbBlock(state, finalBlock);
  keccakF1600(state);

  const output = Buffer.alloc(32);
  let written = 0;
  while (written < output.length) {
    for (let lane = 0; lane < RATE_BYTES_256 / 8 && written < output.length; lane += 1) {
      let value = state[lane];
      for (let byte = 0; byte < 8 && written < output.length; byte += 1) {
        output[written] = Number((value >> BigInt(byte * 8)) & 0xffn);
        written += 1;
      }
    }
    if (written < output.length) keccakF1600(state);
  }
  return output;
}

export function keccak256Hex(input) {
  return keccak256(input).toString("hex");
}

function absorbBlock(state, block) {
  for (let i = 0; i < block.length; i += 1) {
    const lane = Math.floor(i / 8);
    const shift = BigInt((i % 8) * 8);
    state[lane] = (state[lane] ^ (BigInt(block[i]) << shift)) & MASK_64;
  }
}

function keccakF1600(state) {
  for (const rc of ROUND_CONSTANTS) {
    const c = Array(5).fill(0n);
    const d = Array(5).fill(0n);

    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotateLeft(c[(x + 1) % 5], 1n);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64;
      }
    }

    const b = Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const source = x + 5 * y;
        const target = y + 5 * ((2 * x + 3 * y) % 5);
        b[target] = rotateLeft(state[source], ROTATION_OFFSETS[source]);
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])) & MASK_64;
      }
    }

    state[0] = (state[0] ^ rc) & MASK_64;
  }
}

function rotateLeft(value, shift) {
  if (shift === 0n) return value & MASK_64;
  return ((value << shift) | (value >> (64n - shift))) & MASK_64;
}
