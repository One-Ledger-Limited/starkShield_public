import { useState, useCallback } from 'react';
import { generateProof as generateSnarkProof } from '../utils/prover';

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

export const useZKProof = () => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [lastProof, setLastProof] = useState<ProofOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generateProof = useCallback(async (inputs: ProofInputs): Promise<ProofOutput> => {
    setIsGenerating(true);
    setError(null);

    try {
      // Generate ZK proof using snarkjs
      const proof = await generateSnarkProof(inputs);
      
      setLastProof(proof);
      return proof;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      throw err;
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const verifyProof = useCallback(async (
    proof: ProofOutput,
    publicInputs: string[]
  ): Promise<boolean> => {
    try {
      // Verify proof locally (optional, mainly for testing)
      // In production, verification happens on-chain
      const { verifyProof: verifySnarkProof } = await import('../utils/prover');
      return await verifySnarkProof(proof, publicInputs);
    } catch (err) {
      console.error('Proof verification failed:', err);
      return false;
    }
  }, []);

  return {
    generateProof,
    verifyProof,
    isGenerating,
    lastProof,
    error,
  };
};