import { groth16 } from 'snarkjs';
import { keccak256, parseUnits, toUtf8Bytes } from 'ethers';

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
const CIRCUIT_WASM_URL = '/circuits/intent_circuit.wasm';
const CIRCUIT_ZKEY_URL = '/circuits/intent_circuit_final.zkey';
const VERIFICATION_KEY_URL = '/circuits/verification_key.json';

/**
 * Generate a ZK proof for a trade intent
 * This runs entirely client-side in the browser
 */
export const generateProof = async (inputs: ProofInputs): Promise<ProofOutput> => {
  // Generate random salt for the intent
  const salt = BigInt(Math.floor(Math.random() * 1000000000));
  
  // Create private inputs for the circuit
  const inDecimals = tokenDecimals(inputs.tokenIn);
  const outDecimals = tokenDecimals(inputs.tokenOut);
  const amountInUnits = parseUnits(inputs.amountIn || '0', inDecimals);
  const minAmountOutUnits = parseUnits(inputs.minAmountOut || '0', outDecimals);

  const circuitInputs = {
    user: BigInt(inputs.user),
    tokenIn: BigInt(inputs.tokenIn),
    tokenOut: BigInt(inputs.tokenOut),
    amountIn: amountInUnits,
    minAmountOut: minAmountOutUnits,
    deadline: BigInt(inputs.deadline),
    salt: salt,
    // In production, these would be actual merkle proofs
    balanceProof: [0, 0, 0, 0],
    approvalProof: [0, 0, 0, 0],
  };

  // Compute intent hash + nullifier deterministically.
  // Hackathon note: This is not Poseidon; it is a lightweight commitment for demo flows.
  const intentHash = keccak256(toUtf8Bytes(JSON.stringify({
    user: circuitInputs.user.toString(),
    tokenIn: circuitInputs.tokenIn.toString(),
    tokenOut: circuitInputs.tokenOut.toString(),
    amountIn: circuitInputs.amountIn.toString(),
    minAmountOut: circuitInputs.minAmountOut.toString(),
    deadline: circuitInputs.deadline.toString(),
    salt: circuitInputs.salt.toString(),
  })));

  const nullifier = keccak256(toUtf8Bytes(`${circuitInputs.user.toString()}:${circuitInputs.salt.toString()}`));

  // Attempt to generate a real SNARK; if circuits are missing in the deployed build,
  // fall back to a deterministic mock proof so the demo flow remains usable.
  let proofData: string[] = [];
  try {
    const { proof } = await groth16.fullProve(circuitInputs, CIRCUIT_WASM_URL, CIRCUIT_ZKEY_URL);
    proofData = [
      proof.pi_a[0], // A_x
      proof.pi_a[1], // A_y
      proof.pi_b[0][0], // B_x[0]
      proof.pi_b[0][1], // B_x[1]
      proof.pi_b[1][0], // B_y[0]
      proof.pi_b[1][1], // B_y[1]
      proof.pi_c[0], // C_x
      proof.pi_c[1], // C_y
    ].map((x) => BigInt(x).toString());
  } catch (error) {
    console.warn('SNARK proof generation failed; using mock proof for demo.', error);
    proofData = Array.from({ length: 8 }, (_, i) => (i + 1).toString());
  }

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
    intent_hash: intentHash,
    nullifier: nullifier,
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
  return keccak256(toUtf8Bytes(JSON.stringify({
    user: inputs.user,
    tokenIn: inputs.tokenIn,
    tokenOut: inputs.tokenOut,
    amountIn: inputs.amountIn,
    minAmountOut: inputs.minAmountOut,
    deadline: inputs.deadline,
    salt: salt.toString(),
  })));
};

/**
 * Generate nullifier from user address and salt
 */
export const generateNullifier = async (user: string, salt: bigint): Promise<string> => {
  return keccak256(toUtf8Bytes(`${user}:${salt.toString()}`));
};
