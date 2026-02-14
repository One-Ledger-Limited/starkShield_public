use starknet::ContractAddress;
use core::array::{ArrayTrait, SpanTrait};

// Minimal IntentVerifier for testnet MVP.
// WARNING: This does NOT perform real Groth16 verification.

#[starknet::interface]
trait IIntentVerifier<TContractState> {
    fn verify_intent_proof(
        self: @TContractState,
        intent_hash: felt252,
        nullifier: felt252,
        proof_data: Span<felt252>,
        public_inputs: Span<felt252>
    ) -> bool;
}

#[starknet::contract]
mod IntentVerifier {
    use super::*;

    #[storage]
    struct Storage {
        owner: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write(owner);
    }

    #[abi(embed_v0)]
    impl IntentVerifierImpl of super::IIntentVerifier<ContractState> {
        fn verify_intent_proof(
            self: @ContractState,
            intent_hash: felt252,
            nullifier: felt252,
            proof_data: Span<felt252>,
            public_inputs: Span<felt252>
        ) -> bool {
            // Minimal verifier for testnet MVP: accept everything.
            // Keep parameters referenced to avoid unused warnings.
            let _ = intent_hash;
            let _ = nullifier;
            let _ = proof_data.len();
            let _ = public_inputs.len();
            true
        }
    }
}
