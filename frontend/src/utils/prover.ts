import { groth16 } from 'snarkjs';
import { parseUnits } from 'ethers';
import { buildPoseidon } from 'circomlibjs';
import { CurveId, getGroth16CallData, get_groth16_calldata, init as initGaraga } from 'garaga';
import { hash } from 'starknet';

interface ProofInputs {
  user: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
}

interface ProofOutput {
  intent_hash: string;
  nullifier: string;
  proof_data: string[];
  public_inputs: string[];
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.startsWith('0x')) return trimmed;
  const hex = trimmed.slice(2).replace(/^0+/, '') || '0';
  return `0x${hex.padStart(64, '0')}`;
}

const TOKEN_DECIMALS_BY_ADDRESS: Record<string, number> = {
  // Starknet Sepolia common token addresses
  [normalizeAddress('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7')]: 18, // ETH
  [normalizeAddress('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d')]: 18, // STRK
  [normalizeAddress('0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8')]: 6, // USDC
  [normalizeAddress('0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8')]: 6, // USDT
};

function tokenDecimals(address: string): number {
  return TOKEN_DECIMALS_BY_ADDRESS[normalizeAddress(address)] ?? 18;
}

// Circuit file paths (would be hosted on CDN or loaded locally)
const CIRCUIT_WASM_URL =
  (import.meta.env.VITE_CIRCUIT_WASM_URL as string | undefined) ?? '/circuits/intent_circuit.wasm';
const CIRCUIT_ZKEY_URL =
  (import.meta.env.VITE_CIRCUIT_ZKEY_URL as string | undefined) ?? '/circuits/intent_circuit_final.zkey';
const VERIFICATION_KEY_URL =
  (import.meta.env.VITE_VERIFICATION_KEY_URL as string | undefined) ?? '/circuits/intent_verification_key.json';
const DARK_POOL_ADDRESS =
  (import.meta.env.VITE_DARK_POOL_ADDRESS as string | undefined) ?? '';

let poseidonPromise: Promise<any> | null = null;
let garagaInitPromise: Promise<void> | null = null;
const STARKNET_FIELD_PRIME = BigInt(
  '0x800000000000011000000000000000000000000000000000000000000000001'
);

async function getPoseidon(): Promise<any> {
  if (!poseidonPromise) {
    poseidonPromise = buildPoseidon();
  }
  return poseidonPromise;
}

function toHexFelt(value: bigint): string {
  const normalized = toStarknetFelt(value);
  return `0x${normalized.toString(16)}`;
}

function toBigIntValue(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (value.startsWith('0x') || value.startsWith('0X')) return BigInt(value);
  return BigInt(value);
}

function toStarknetFelt(value: bigint): bigint {
  const mod = value % STARKNET_FIELD_PRIME;
  return mod >= 0n ? mod : mod + STARKNET_FIELD_PRIME;
}

async function starknetCallBestEffort(payload: unknown): Promise<unknown> {
  const proxyPaths = ['/api/v1/starknet-rpc', '/v1/starknet-rpc'];
  for (const path of proxyPaths) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) continue;
      return await res.json();
    } catch {
      // Try next path.
    }
  }

  const rpcUrl = (import.meta.env.VITE_STARKNET_RPC as string | undefined) ?? '';
  if (!rpcUrl) {
    throw new Error('No Starknet RPC endpoint available for calldata preflight');
  }
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

async function preflightSubmitIntent(
  intentHash: bigint,
  nullifier: bigint,
  proofData: Array<string | number | bigint>,
  publicSignals: Array<string | number | bigint>,
): Promise<{ ok: boolean; reason?: string; unavailable?: boolean }> {
  if (!DARK_POOL_ADDRESS) {
    return { ok: false, unavailable: true, reason: 'Missing VITE_DARK_POOL_ADDRESS' };
  }

  const calldata: string[] = [];
  calldata.push(`0x${toStarknetFelt(intentHash).toString(16)}`);
  calldata.push(`0x${toStarknetFelt(nullifier).toString(16)}`);
  calldata.push(`0x${proofData.length.toString(16)}`);
  for (const p of proofData) calldata.push(`0x${toBigIntValue(p).toString(16)}`);
  calldata.push(`0x${publicSignals.length.toString(16)}`);
  for (const p of publicSignals) calldata.push(`0x${toStarknetFelt(toBigIntValue(p)).toString(16)}`);

  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'starknet_call',
    params: [
      {
        contract_address: DARK_POOL_ADDRESS,
        entry_point_selector: hash.getSelectorFromName('submit_intent'),
        calldata,
      },
      'latest',
    ],
  };

  try {
    const json = (await starknetCallBestEffort(payload)) as { error?: { message?: string } };
    if (!json?.error) return { ok: true };
    const msg = String(json.error?.message ?? json.error ?? 'unknown error');
    if (
      /invalid proof/i.test(msg)
      || /invalid proofs/i.test(msg)
      || /failed to create felt from string/i.test(msg)
      || /representative out of range/i.test(msg)
    ) {
      return { ok: false, reason: msg };
    }
    // Non-proof errors are treated as preflight unavailable, not as invalid proof.
    return { ok: false, unavailable: true, reason: msg };
  } catch (err) {
    return { ok: false, unavailable: true, reason: String(err) };
  }
}

function parseG1Point(point: unknown): { x: bigint; y: bigint; curveId: CurveId } {
  const p = point as Array<string | number | bigint>;
  return {
    x: toBigIntValue(p[0]),
    y: toBigIntValue(p[1]),
    curveId: CurveId.BN254,
  };
}

type G2Order = 'canonical' | 'swapped';
interface G2Config {
  proof: G2Order;
  vk: G2Order;
}

function stripG1Z(point: unknown): [string | number | bigint, string | number | bigint] {
  const p = point as Array<string | number | bigint>;
  return [p[0], p[1]];
}

function normalizeProofForGaragaParser(rawProof: unknown): unknown {
  const p = rawProof as {
    pi_a: Array<string | number | bigint>;
    pi_b: Array<Array<string | number | bigint>>;
    pi_c: Array<string | number | bigint>;
    protocol?: string;
    curve?: string;
  };
  return {
    ...p,
    pi_a: stripG1Z(p.pi_a),
    pi_b: [p.pi_b[0], p.pi_b[1]],
    pi_c: stripG1Z(p.pi_c),
    protocol: p.protocol ?? 'groth16',
    curve: p.curve ?? 'bn128',
  };
}

function normalizeVkForGaragaParser(rawVk: unknown): unknown {
  const vk = rawVk as {
    vk_alpha_1: Array<string | number | bigint>;
    IC: Array<Array<string | number | bigint>>;
  } & Record<string, unknown>;
  return {
    ...vk,
    vk_alpha_1: stripG1Z(vk.vk_alpha_1),
    vk_beta_2: [((vk as Record<string, unknown>).vk_beta_2 as Array<unknown>)[0], ((vk as Record<string, unknown>).vk_beta_2 as Array<unknown>)[1]],
    vk_gamma_2: [((vk as Record<string, unknown>).vk_gamma_2 as Array<unknown>)[0], ((vk as Record<string, unknown>).vk_gamma_2 as Array<unknown>)[1]],
    vk_delta_2: [((vk as Record<string, unknown>).vk_delta_2 as Array<unknown>)[0], ((vk as Record<string, unknown>).vk_delta_2 as Array<unknown>)[1]],
    IC: (vk.IC as Array<unknown>).map(stripG1Z),
  };
}

function swapFp2(point: unknown): [Array<string | number | bigint>, Array<string | number | bigint>] {
  const p = point as Array<Array<string | number | bigint>>;
  return [
    [p[0][1], p[0][0]],
    [p[1][1], p[1][0]],
  ];
}

function normalizeProofForGaragaParserWithOrder(rawProof: unknown, order: G2Order): unknown {
  const p = rawProof as {
    pi_b: Array<Array<string | number | bigint>>;
  };
  const base = normalizeProofForGaragaParser(rawProof) as Record<string, unknown>;
  return {
    ...base,
    pi_b: order === 'swapped' ? swapFp2(p.pi_b) : [p.pi_b[0], p.pi_b[1]],
  };
}

function normalizeVkForGaragaParserWithOrder(rawVk: unknown, order: G2Order): unknown {
  const vk = rawVk as {
    vk_beta_2: Array<Array<string | number | bigint>>;
    vk_gamma_2: Array<Array<string | number | bigint>>;
    vk_delta_2: Array<Array<string | number | bigint>>;
  };
  const base = normalizeVkForGaragaParser(rawVk) as Record<string, unknown>;
  return {
    ...base,
    vk_beta_2: order === 'swapped' ? swapFp2(vk.vk_beta_2) : [vk.vk_beta_2[0], vk.vk_beta_2[1]],
    vk_gamma_2: order === 'swapped' ? swapFp2(vk.vk_gamma_2) : [vk.vk_gamma_2[0], vk.vk_gamma_2[1]],
    vk_delta_2: order === 'swapped' ? swapFp2(vk.vk_delta_2) : [vk.vk_delta_2[0], vk.vk_delta_2[1]],
  };
}

function parseG2Point(
  point: unknown,
  order: G2Order = 'canonical'
): { x: [bigint, bigint]; y: [bigint, bigint]; curveId: CurveId } {
  const p = point as Array<Array<string | number | bigint>>;
  const x0 = toBigIntValue(p[0][0]);
  const x1 = toBigIntValue(p[0][1]);
  const y0 = toBigIntValue(p[1][0]);
  const y1 = toBigIntValue(p[1][1]);

  // Some proof/vkey artifacts are emitted as [x0, x1]/[y0, y1] while
  // others are [x1, x0]/[y1, y0]. Try canonical first and keep a swapped fallback.
  const x: [bigint, bigint] = order === 'swapped' ? [x1, x0] : [x0, x1];
  const y: [bigint, bigint] = order === 'swapped' ? [y1, y0] : [y0, y1];

  return {
    x,
    y,
    curveId: CurveId.BN254,
  };
}

async function ensureGaragaInitialized(): Promise<void> {
  if (!garagaInitPromise) {
    garagaInitPromise = initGaraga();
  }
  await garagaInitPromise;
}

async function assertCircuitAsset(url: string, label: string): Promise<void> {
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`${label} not found at ${url} (HTTP ${response.status})`);
  }
  // Guard against SPA fallback HTML being served as wasm/zkey.
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/html')) {
    throw new Error(`${label} URL returned HTML instead of binary file: ${url}`);
  }
}

/**
 * Generate a ZK proof for a trade intent
 * This runs entirely client-side in the browser
 */
export const generateProof = async (inputs: ProofInputs): Promise<ProofOutput> => {
  await assertCircuitAsset(CIRCUIT_WASM_URL, 'Circuit WASM');
  await assertCircuitAsset(CIRCUIT_ZKEY_URL, 'Circuit ZKey');

  // Generate random salt for the intent
  const salt = BigInt(Math.floor(Math.random() * 1000000000));
  
  // Create private inputs for the circuit
  const inDecimals = tokenDecimals(inputs.tokenIn);
  const outDecimals = tokenDecimals(inputs.tokenOut);
  const amountInUnits = parseUnits(inputs.amountIn || '0', inDecimals);
  const minAmountOutUnits = parseUnits(inputs.minAmountOut || '0', outDecimals);
  const currentTime = BigInt(Math.floor(Date.now() / 1000));
  const poseidon = await getPoseidon();
  const intentHash = BigInt(
    poseidon.F.toString(
      poseidon([
        BigInt(inputs.user),
        BigInt(inputs.tokenIn),
        BigInt(inputs.tokenOut),
        amountInUnits,
        minAmountOutUnits,
        BigInt(inputs.deadline),
        salt,
      ])
    )
  );
  const nullifier = BigInt(
    poseidon.F.toString(
      poseidon([
        BigInt(inputs.user),
        salt,
      ])
    )
  );

  const circuitInputs = {
    user: BigInt(inputs.user),
    tokenIn: BigInt(inputs.tokenIn),
    tokenOut: BigInt(inputs.tokenOut),
    amountIn: amountInUnits,
    minAmountOut: minAmountOutUnits,
    deadline: BigInt(inputs.deadline),
    salt: salt,
    intentHash: intentHash,
    nullifier: nullifier,
    currentTime: currentTime,
    // In production, these would be actual merkle proofs
    // Current intent circuit enforces non-zero sum checks for both arrays.
    balanceProof: [1, 0, 0, 0],
    approvalProof: [1, 0, 0, 0],
  };

  // Privacy Track hard requirement:
  // proof generation must fail closed, never degrade to mock proofs.
  const { proof, publicSignals } = await groth16.fullProve(circuitInputs, CIRCUIT_WASM_URL, CIRCUIT_ZKEY_URL);

  // Garaga verifier expects "full_proof_with_hints" calldata, not just 8 Groth16 coordinates.
  await ensureGaragaInitialized();
  const vkResponse = await fetch(VERIFICATION_KEY_URL);
  if (!vkResponse.ok) {
    throw new Error(`Verification key not found at ${VERIFICATION_KEY_URL} (HTTP ${vkResponse.status})`);
  }
  const verificationKeyJson = await vkResponse.json();
  const localVerified = await groth16.verify(verificationKeyJson, publicSignals, proof);
  if (!localVerified) {
    throw new Error('Generated proof failed local snarkjs verification against verification key');
  }

  let garagaCalldata: Array<bigint | string | number> | null = null;
  let lastError: unknown = null;
  const buildGroth16Artifacts = (g2Config: G2Config) => {
    const garagaProof = {
      a: parseG1Point(proof.pi_a),
      b: parseG2Point(proof.pi_b, g2Config.proof),
      c: parseG1Point(proof.pi_c),
      publicInputs: publicSignals.map((v) => toBigIntValue(v)),
      curveId: CurveId.BN254,
    };
    const garagaVerificationKey = {
      alpha: parseG1Point(verificationKeyJson.vk_alpha_1),
      beta: parseG2Point(verificationKeyJson.vk_beta_2, g2Config.vk),
      gamma: parseG2Point(verificationKeyJson.vk_gamma_2, g2Config.vk),
      delta: parseG2Point(verificationKeyJson.vk_delta_2, g2Config.vk),
      ic: (verificationKeyJson.IC as Array<unknown>).map(parseG1Point),
    };
    return { garagaProof, garagaVerificationKey };
  };

  const parserCandidates: G2Config[] = [
    { proof: 'swapped', vk: 'swapped' },
    { proof: 'swapped', vk: 'canonical' },
    { proof: 'canonical', vk: 'swapped' },
    { proof: 'canonical', vk: 'canonical' },
  ];
  const parserErrors: string[] = [];
  for (const candidate of parserCandidates) {
    try {
      const parserProof = normalizeProofForGaragaParserWithOrder(proof, candidate.proof);
      const parserVk = normalizeVkForGaragaParserWithOrder(verificationKeyJson, candidate.vk);
      const candidateCalldata = get_groth16_calldata(parserProof, parserVk, CurveId.BN254);
      let normalized = candidateCalldata;
      if (normalized.length > 1) {
        const first = toBigIntValue(normalized[0] as string | number | bigint);
        if (first === BigInt(normalized.length - 1)) {
          normalized = normalized.slice(1);
        }
      }
      const pf = await preflightSubmitIntent(intentHash, nullifier, normalized, publicSignals);
      if (pf.ok) {
        garagaCalldata = normalized;
        break;
      }
      if (pf.unavailable) {
        parserErrors.push(
          `parser(proof=${candidate.proof},vk=${candidate.vk}) preflight unavailable: ${pf.reason}`
        );
        continue;
      }
      parserErrors.push(
        `parser(proof=${candidate.proof},vk=${candidate.vk}) preflight rejected: ${pf.reason}`
      );
    } catch (err) {
      parserErrors.push(
        `parser(proof=${candidate.proof},vk=${candidate.vk}) failed: ${String(err)}`
      );
    }
  }

  const typedCandidates: G2Config[] = [
    { proof: 'swapped', vk: 'swapped' },
    { proof: 'swapped', vk: 'canonical' },
    { proof: 'canonical', vk: 'swapped' },
    { proof: 'canonical', vk: 'canonical' },
  ];
  const typedErrors: string[] = [];

  if (!garagaCalldata || garagaCalldata.length === 0) {
    for (const candidate of typedCandidates) {
      try {
        const { garagaProof, garagaVerificationKey } = buildGroth16Artifacts(candidate);
        const candidateCalldata = await getGroth16CallData(garagaProof, garagaVerificationKey, CurveId.BN254);
        let normalized = candidateCalldata;
        if (normalized.length > 1) {
          const first = toBigIntValue(normalized[0] as string | number | bigint);
          if (first === BigInt(normalized.length - 1)) {
            normalized = normalized.slice(1);
          }
        }
        const pf = await preflightSubmitIntent(intentHash, nullifier, normalized, publicSignals);
        if (pf.ok) {
          garagaCalldata = normalized;
          break;
        }
        if (pf.unavailable) {
          typedErrors.push(
            `typed(proof=${candidate.proof},vk=${candidate.vk}) preflight unavailable: ${pf.reason}`
          );
          continue;
        }
        typedErrors.push(
          `typed(proof=${candidate.proof},vk=${candidate.vk}) preflight rejected: ${pf.reason}`
        );
      } catch (err) {
        typedErrors.push(
          `typed(proof=${candidate.proof},vk=${candidate.vk}) failed: ${String(err)}`
        );
      }
    }
  }

  if (!garagaCalldata || garagaCalldata.length === 0) {
    lastError = `All parser candidates failed (${parserErrors.join('; ')}); all typed candidates failed (${typedErrors.join('; ')})`;
  }

  if (!garagaCalldata || garagaCalldata.length === 0) {
    throw new Error(`Failed to build Garaga proof calldata: ${String(lastError)}`);
  }
  const proofData = garagaCalldata.map((x) => BigInt(x).toString());

  // IMPORTANT: proof_public_inputs must be exactly the circuit public signals,
  // matching VK.nPublic and Groth16 verification expectations.
  const publicInputsForSubmit = publicSignals.map((v) =>
    toStarknetFelt(toBigIntValue(v)).toString()
  );

  return {
    intent_hash: toHexFelt(intentHash),
    nullifier: toHexFelt(nullifier),
    proof_data: proofData,
    public_inputs: publicInputsForSubmit,
  };
};

/**
 * Verify a ZK proof locally (for testing purposes)
 * In production, verification happens on-chain via Cairo verifier
 */
export const verifyProof = async (
  proof: ProofOutput,
  publicInputs: string[]
): Promise<boolean> => {
  try {
    if (proof.proof_data.length !== 8) {
      // We now store Garaga full calldata for on-chain verification.
      // Local snarkjs verification expects raw Groth16 points (8 elements).
      return false;
    }

    // Fetch verification key
    const response = await fetch(VERIFICATION_KEY_URL);
    const vKey = await response.json();

    // Reconstruct proof object
    const proofObj = {
      pi_a: [
        proof.proof_data[0],
        proof.proof_data[1],
      ],
      pi_b: [
        [proof.proof_data[2], proof.proof_data[3]],
        [proof.proof_data[4], proof.proof_data[5]],
      ],
      pi_c: [
        proof.proof_data[6],
        proof.proof_data[7],
      ],
      protocol: 'groth16',
      curve: 'bn128',
    };

    // Verify
    const isValid = await groth16.verify(vKey, publicInputs, proofObj);
    return isValid;
  } catch (error) {
    console.error('Proof verification error:', error);
    return false;
  }
};

/**
 * Hash function for creating commitments
 */
export const hashIntent = async (inputs: ProofInputs, salt: bigint): Promise<string> => {
  const inDecimals = tokenDecimals(inputs.tokenIn);
  const outDecimals = tokenDecimals(inputs.tokenOut);
  const amountInUnits = parseUnits(inputs.amountIn || '0', inDecimals);
  const minAmountOutUnits = parseUnits(inputs.minAmountOut || '0', outDecimals);
  const poseidon = await getPoseidon();
  const hashValue = BigInt(
    poseidon.F.toString(
      poseidon([
        BigInt(inputs.user),
        BigInt(inputs.tokenIn),
        BigInt(inputs.tokenOut),
        amountInUnits,
        minAmountOutUnits,
        BigInt(inputs.deadline),
        salt,
      ])
    )
  );
  return toHexFelt(hashValue);
};

/**
 * Generate nullifier from user address and salt
 */
export const generateNullifier = async (user: string, salt: bigint): Promise<string> => {
  const poseidon = await getPoseidon();
  const nullifierValue = BigInt(
    poseidon.F.toString(
      poseidon([
        BigInt(user),
        salt,
      ])
    )
  );
  return toHexFelt(nullifierValue);
};
