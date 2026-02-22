import { groth16 } from 'snarkjs';
import { parseUnits } from 'ethers';
import { buildPoseidon } from 'circomlibjs';
import { CurveId, getGroth16CallData, get_groth16_calldata, init as initGaraga } from 'garaga';

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

let poseidonPromise: Promise<any> | null = null;
let garagaInitPromise: Promise<void> | null = null;

async function getPoseidon(): Promise<any> {
  if (!poseidonPromise) {
    poseidonPromise = buildPoseidon();
  }
  return poseidonPromise;
}

function toHexFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function toBigIntValue(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (value.startsWith('0x') || value.startsWith('0X')) return BigInt(value);
  return BigInt(value);
}

function parseG1Point(point: unknown): { x: bigint; y: bigint; curveId: CurveId } {
  const p = point as Array<string | number | bigint>;
  return {
    x: toBigIntValue(p[0]),
    y: toBigIntValue(p[1]),
    curveId: CurveId.BN254,
  };
}

function parseG2Point(point: unknown): { x: [bigint, bigint]; y: [bigint, bigint]; curveId: CurveId } {
  const p = point as Array<Array<string | number | bigint>>;
  return {
    x: [toBigIntValue(p[0][0]), toBigIntValue(p[0][1])],
    y: [toBigIntValue(p[1][0]), toBigIntValue(p[1][1])],
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

  let garagaCalldata: Array<bigint | string | number> | null = null;
  let lastError: unknown = null;

  // Path A (preferred): pass snarkjs-shaped objects to Garaga wasm parser directly.
  // This avoids manual field remapping/order mistakes.
  try {
    const proofJs = {
      ...proof,
      publicSignals,
      public_inputs: publicSignals,
      publicInputs: publicSignals,
    };
    garagaCalldata = get_groth16_calldata(proofJs, verificationKeyJson, CurveId.BN254);
  } catch (err) {
    lastError = err;
  }

  // Path B fallback: typed high-level API mapping.
  if (!garagaCalldata || garagaCalldata.length === 0) {
    try {
      const garagaProof = {
        a: parseG1Point(proof.pi_a),
        b: parseG2Point(proof.pi_b),
        c: parseG1Point(proof.pi_c),
        publicInputs: publicSignals.map((v) => toBigIntValue(v)),
        curveId: CurveId.BN254,
      };
      const garagaVerificationKey = {
        alpha: parseG1Point(verificationKeyJson.vk_alpha_1),
        beta: parseG2Point(verificationKeyJson.vk_beta_2),
        gamma: parseG2Point(verificationKeyJson.vk_gamma_2),
        delta: parseG2Point(verificationKeyJson.vk_delta_2),
        ic: (verificationKeyJson.IC as Array<unknown>).map(parseG1Point),
      };
      garagaCalldata = await getGroth16CallData(garagaProof, garagaVerificationKey, CurveId.BN254);
    } catch (err) {
      lastError = err;
    }
  }

  if (!garagaCalldata || garagaCalldata.length === 0) {
    throw new Error(`Failed to build Garaga proof calldata: ${String(lastError)}`);
  }
  let normalizedCalldata = garagaCalldata;
  // Garaga helpers may return a "felt-array serialized" payload where the first felt
  // is the array length. Our contract already receives `Span<felt252>`, so keep raw body only.
  if (normalizedCalldata.length > 1) {
    const first = toBigIntValue(normalizedCalldata[0] as string | number | bigint);
    if (first === BigInt(normalizedCalldata.length - 1)) {
      normalizedCalldata = normalizedCalldata.slice(1);
    }
  }
  const proofData = normalizedCalldata.map((x) => BigInt(x).toString());

  // Public inputs that will be visible on-chain
  const publicInputs = [
    circuitInputs.user.toString(),
    circuitInputs.tokenIn.toString(),
    circuitInputs.tokenOut.toString(),
    circuitInputs.amountIn.toString(),
    circuitInputs.minAmountOut.toString(),
    circuitInputs.deadline.toString(),
  ];

  return {
    intent_hash: toHexFelt(intentHash),
    nullifier: toHexFelt(nullifier),
    proof_data: proofData,
    public_inputs: publicInputs,
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
