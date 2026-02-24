use starknet::ContractAddress;
use core::array::{ArrayTrait, SpanTrait};
use starknet::get_caller_address;
use core::result::Result;

// Adapter verifier that forwards proof calldata to a Garaga-generated verifier contract.
// This replaces the old placeholder "always true" implementation.

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

#[starknet::interface]
trait IIntentVerifierAdmin<TContractState> {
    fn update_garaga_verifier(ref self: TContractState, new_verifier: ContractAddress);
    fn get_garaga_verifier(self: @TContractState) -> ContractAddress;
}

#[starknet::contract]
mod IntentVerifier {
    use super::*;

    #[storage]
    struct Storage {
        owner: ContractAddress,
        garaga_verifier_contract: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        garaga_verifier_contract: ContractAddress,
    ) {
        self.owner.write(owner);
        self.garaga_verifier_contract.write(garaga_verifier_contract);
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
            // Keep these referenced to avoid warnings and preserve interface compatibility.
            let _ = intent_hash;
            let _ = nullifier;
            let _ = public_inputs.len();

            if proof_data.len() == 0 {
                return false;
            }

            // `call_contract_syscall` requires fully ABI-serialized calldata.
            // Garaga entrypoint expects `Span<felt252>`, i.e. `[len, ...elements]`.
            let mut forwarded: Array<felt252> = array![];
            forwarded.append(proof_data.len().into());
            let mut i = 0;
            loop {
                if i >= proof_data.len() {
                    break;
                }
                forwarded.append(*proof_data.at(i));
                i += 1;
            };

            // Forward calldata to Garaga-generated verifier:
            // verify_groth16_proof_bn254(...)
            let call_result = starknet::syscalls::call_contract_syscall(
                self.garaga_verifier_contract.read(),
                selector!("verify_groth16_proof_bn254"),
                forwarded.span()
            );

            match call_result {
                Result::Ok(retdata) => {
                    if retdata.len() == 0 {
                        return false;
                    }
                    // Garaga verifier returns `Option<Span<u256>>`:
                    // Some(public_inputs) => tag = 0, None => tag = 1.
                    // Previous `first_word != 0` logic inverted this and rejected valid proofs.
                    let option_tag = *retdata.at(0);
                    option_tag == 0
                },
                Result::Err(_) => false,
            }
        }
    }

    #[abi(embed_v0)]
    impl IntentVerifierAdminImpl of super::IIntentVerifierAdmin<ContractState> {
        fn update_garaga_verifier(ref self: ContractState, new_verifier: ContractAddress) {
            self._assert_owner();
            self.garaga_verifier_contract.write(new_verifier);
        }

        fn get_garaga_verifier(self: @ContractState) -> ContractAddress {
            self.garaga_verifier_contract.read()
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _assert_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'Only owner');
        }
    }
}
