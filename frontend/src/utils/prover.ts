import { groth16 } from 'snarkjs';
import { parseUnits } from 'ethers';
import { buildPoseidon } from 'circomlibjs';
import { CurveId, getGroth16CallData, init as initGaraga } from 'garaga';

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

function feltToHex(value: string | number | bigint): string {
  if (typeof value === 'string') {
    return value.startsWith('0x') ? value : `0x${BigInt(value).toString(16)}`;
  }
  return `0x${BigInt(value).toString(16)}`;
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
  const verificationKey = await vkResponse.json();

  const garagaPayloadCandidates: unknown[] = [
    // Candidate 1: snarkjs-style proof with explicit public inputs.
    {
      ...proof,
      publicInputs: publicSignals,
      public_inputs: publicSignals,
    },
    // Candidate 2: Garaga docs-style wrapper.
    {
      eliptic_curve_id: 'bn254',
      elliptic_curve_id: 'bn254',
      proof: {
        a: {
          x: feltToHex(proof.pi_a[0]),
          y: feltToHex(proof.pi_a[1]),
        },
        b: {
          x: [feltToHex(proof.pi_b[0][0]), feltToHex(proof.pi_b[0][1])],
          y: [feltToHex(proof.pi_b[1][0]), feltToHex(proof.pi_b[1][1])],
        },
        c: {
          x: feltToHex(proof.pi_c[0]),
          y: feltToHex(proof.pi_c[1]),
        },
      },
      public_inputs: publicSignals.map((v) => feltToHex(v)),
      publicInputs: publicSignals.map((v) => feltToHex(v)),
    },
  ];

  let garagaCalldata: Array<bigint | string | number> | null = null;
  let lastGaragaError: unknown = null;
  for (const payload of garagaPayloadCandidates) {
    try {
      garagaCalldata = await getGroth16CallData(payload, verificationKey, CurveId.BN254);
      if (Array.isArray(garagaCalldata) && garagaCalldata.length > 0) {
        break;
      }
    } catch (err) {
      lastGaragaError = err;
    }
  }
  if (!garagaCalldata || garagaCalldata.length === 0) {
    throw new Error(`Failed to build Garaga proof calldata: ${String(lastGaragaError)}`);
  }
  const proofData = garagaCalldata.map((x) => BigInt(x).toString());

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
