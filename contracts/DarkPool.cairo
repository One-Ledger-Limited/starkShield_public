use starknet::{
    ContractAddress, get_caller_address, get_block_timestamp, get_contract_address
};
use core::traits::Into;
use core::array::{ArrayTrait, SpanTrait};

#[starknet::interface]
trait IDarkPool<TContractState> {
    fn submit_intent(ref self: TContractState, proof: IntentProof);
    fn settle_match(
        ref self: TContractState, 
        intent_a: IntentProof, 
        intent_b: IntentProof,
        settlement_data: SettlementData
    );
    fn cancel_intent(ref self: TContractState, nullifier: felt252);
    fn get_intent_status(self: @TContractState, nullifier: felt252) -> IntentStatus;
}

#[derive(Drop, Serde, starknet::Store, Clone)]
struct TradeIntent {
    user: ContractAddress,
    token_in: ContractAddress,
    token_out: ContractAddress,
    amount_in: u256,
    min_amount_out: u256,
    deadline: u64,
    salt: felt252,
}

#[derive(Drop, Serde)]
struct IntentProof {
    intent_hash: felt252,
    nullifier: felt252,
    proof_data: Span<felt252>,
    public_inputs: Span<felt252>,
}

#[derive(Drop, Serde)]
struct SettlementData {
    ekubo_pool: ContractAddress,
    sqrt_price_limit: u256,
}

#[derive(Drop, Serde, PartialEq)]
enum IntentStatus {
    Pending,
    Settled,
    Cancelled,
    Expired,
}

#[starknet::contract]
mod DarkPool {
    use super::*;
    use starknet::{
        ContractAddress, get_caller_address, get_block_timestamp, get_contract_address
    };
    use core::array::ArrayTrait;
    use core::traits::Into;
    
    // Minimal ERC20 interface (avoids pulling OpenZeppelin for testnet MVP builds).
    #[starknet::interface]
    trait IERC20<TContractState> {
        fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256);
        fn transfer_from(
            ref self: TContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256
        );
    }

    #[storage]
    struct Storage {
        owner: ContractAddress,
        verifier_contract: ContractAddress,
        ekubo_router: ContractAddress,
        // Store status as u8 to avoid enum store edge cases when reading unset keys.
        // 0=Pending, 1=Settled, 2=Cancelled, 3=Expired.
        intents: LegacyMap<felt252, u8>,
        user_intents: LegacyMap<ContractAddress, felt252>,
        fee_recipient: ContractAddress,
        protocol_fee_bps: u16,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        IntentSubmitted: IntentSubmitted,
        IntentSettled: IntentSettled,
        IntentCancelled: IntentCancelled,
        ProofVerified: ProofVerified,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentSubmitted {
        user: ContractAddress,
        nullifier: felt252,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentSettled {
        nullifier_a: felt252,
        nullifier_b: felt252,
        token_in: ContractAddress,
        token_out: ContractAddress,
        amount_in: u256,
        amount_out: u256,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentCancelled {
        user: ContractAddress,
        nullifier: felt252,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct ProofVerified {
        nullifier: felt252,
        verifier: ContractAddress,
        success: bool,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        verifier_contract: ContractAddress,
        ekubo_router: ContractAddress,
        fee_recipient: ContractAddress,
        protocol_fee_bps: u16,
    ) {
        self.owner.write(owner);
        self.verifier_contract.write(verifier_contract);
        self.ekubo_router.write(ekubo_router);
        self.fee_recipient.write(fee_recipient);
        self.protocol_fee_bps.write(protocol_fee_bps);
    }

    #[abi(embed_v0)]
    impl DarkPoolImpl of super::IDarkPool<ContractState> {
        fn submit_intent(ref self: ContractState, proof: IntentProof) {
            // Check intent not already submitted
            let current_status = self._read_status(proof.nullifier);
            assert(current_status == IntentStatus::Pending, 'Intent already exists');
            
            // Verify the proof
            let verifier = IIntentVerifierDispatcher {
                contract_address: self.verifier_contract.read()
            };
            
            let is_valid = verifier.verify_intent_proof(
                proof.intent_hash,
                proof.nullifier,
                proof.proof_data,
                proof.public_inputs
            );
            
            assert(is_valid, 'Invalid proof');
            
            // Mark intent as pending
            self._write_status(proof.nullifier, IntentStatus::Pending);
            
            // Emit event
            self.emit(Event::IntentSubmitted(
                IntentSubmitted {
                    user: get_caller_address(),
                    nullifier: proof.nullifier,
                    timestamp: get_block_timestamp(),
                }
            ));
            
            self.emit(Event::ProofVerified(
                ProofVerified {
                    nullifier: proof.nullifier,
                    verifier: self.verifier_contract.read(),
                    success: true,
                }
            ));
        }

        fn settle_match(
            ref self: ContractState,
            intent_a: IntentProof,
            intent_b: IntentProof,
            settlement_data: SettlementData
        ) {
            // Only solver can settle
            self._assert_solver();
            
            // Check both intents are pending
            assert(
                self._read_status(intent_a.nullifier) == IntentStatus::Pending,
                'Intent A not pending'
            );
            assert(
                self._read_status(intent_b.nullifier) == IntentStatus::Pending,
                'Intent B not pending'
            );
            
            // Verify both proofs
            let verifier = IIntentVerifierDispatcher {
                contract_address: self.verifier_contract.read()
            };
            
            let valid_a = verifier.verify_intent_proof(
                intent_a.intent_hash,
                intent_a.nullifier,
                intent_a.proof_data,
                intent_a.public_inputs
            );
            
            let valid_b = verifier.verify_intent_proof(
                intent_b.intent_hash,
                intent_b.nullifier,
                intent_b.proof_data,
                intent_b.public_inputs
            );
            
            assert(valid_a && valid_b, 'Invalid proofs');
            
            // Verify compatibility (matching tokens and amounts)
            self._verify_intent_compatibility(
                intent_a.public_inputs,
                intent_b.public_inputs
            );
            
            // Execute settlement
            self._execute_settlement(
                intent_a.public_inputs,
                intent_b.public_inputs,
                settlement_data
            );
            
            // Mark intents as settled
            self._write_status(intent_a.nullifier, IntentStatus::Settled);
            self._write_status(intent_b.nullifier, IntentStatus::Settled);
            
            // Emit settlement event
            self.emit(Event::IntentSettled(
                IntentSettled {
                    nullifier_a: intent_a.nullifier,
                    nullifier_b: intent_b.nullifier,
                    token_in: (*intent_a.public_inputs.at(1)).try_into().unwrap(),
                    token_out: (*intent_a.public_inputs.at(2)).try_into().unwrap(),
                    amount_in: (*intent_a.public_inputs.at(3)).into(),
                    amount_out: (*intent_a.public_inputs.at(4)).into(),
                    timestamp: get_block_timestamp(),
                }
            ));
        }

        fn cancel_intent(ref self: ContractState, nullifier: felt252) {
            // Only intent owner can cancel
            // Note: In production, would verify ownership via stored intent data
            let current_status = self._read_status(nullifier);
            assert(current_status == IntentStatus::Pending, 'Intent not pending');
            
            self._write_status(nullifier, IntentStatus::Cancelled);
            
            self.emit(Event::IntentCancelled(
                IntentCancelled {
                    user: get_caller_address(),
                    nullifier: nullifier,
                    timestamp: get_block_timestamp(),
                }
            ));
        }

        fn get_intent_status(self: @ContractState, nullifier: felt252) -> IntentStatus {
            self._read_status(nullifier)
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn _status_to_u8(self: @ContractState, status: IntentStatus) -> u8 {
            match status {
                IntentStatus::Pending => 0,
                IntentStatus::Settled => 1,
                IntentStatus::Cancelled => 2,
                IntentStatus::Expired => 3,
            }
        }

        fn _u8_to_status(self: @ContractState, v: u8) -> IntentStatus {
            match v {
                0 => IntentStatus::Pending,
                1 => IntentStatus::Settled,
                2 => IntentStatus::Cancelled,
                3 => IntentStatus::Expired,
                _ => IntentStatus::Pending,
            }
        }

        fn _read_status(self: @ContractState, nullifier: felt252) -> IntentStatus {
            let v = self.intents.read(nullifier);
            self._u8_to_status(v)
        }

        fn _write_status(ref self: ContractState, nullifier: felt252, status: IntentStatus) {
            let v = self._status_to_u8(status);
            self.intents.write(nullifier, v);
        }

        fn _assert_solver(self: @ContractState) {
            // In production, check against authorized solver list
            // For MVP, only owner can settle
            assert(get_caller_address() == self.owner.read(), 'Unauthorized solver');
        }

        fn _verify_intent_compatibility(
            self: @ContractState,
            public_inputs_a: Span<felt252>,
            public_inputs_b: Span<felt252>
        ) {
            // Verify tokens match (A's token_in == B's token_out, etc.)
            assert(
                *public_inputs_a.at(1) == *public_inputs_b.at(2),
                'Token mismatch'
            );
            assert(
                *public_inputs_a.at(2) == *public_inputs_b.at(1),
                'Token mismatch'
            );
            
            // Verify amounts match within acceptable slippage
            let amount_in_a: u256 = (*public_inputs_a.at(3)).into();
            let amount_out_a: u256 = (*public_inputs_a.at(4)).into();
            let amount_in_b: u256 = (*public_inputs_b.at(3)).into();
            let amount_out_b: u256 = (*public_inputs_b.at(4)).into();
            
            // A's input should match B's minimum output
            assert(amount_in_a >= amount_out_b, 'Amount mismatch');
            // B's input should match A's minimum output  
            assert(amount_in_b >= amount_out_a, 'Amount mismatch');
        }

        fn _execute_settlement(
            ref self: ContractState,
            public_inputs_a: Span<felt252>,
            public_inputs_b: Span<felt252>,
            settlement_data: SettlementData
        ) {
            let user_a: ContractAddress = (*public_inputs_a.at(0)).try_into().unwrap();
            let user_b: ContractAddress = (*public_inputs_b.at(0)).try_into().unwrap();
            let token_in_a: ContractAddress = (*public_inputs_a.at(1)).try_into().unwrap();
            let token_out_a: ContractAddress = (*public_inputs_a.at(2)).try_into().unwrap();
            let amount_in_a: u256 = (*public_inputs_a.at(3)).into();
            let min_amount_out_a: u256 = (*public_inputs_a.at(4)).into();
            let amount_in_b: u256 = (*public_inputs_b.at(3)).into();
            let min_amount_out_b: u256 = (*public_inputs_b.at(4)).into();
            
            // Transfer tokens from users to contract
            let token_a_dispatcher = IERC20Dispatcher { contract_address: token_in_a };
            let token_b_dispatcher = IERC20Dispatcher { contract_address: token_out_a };
            
            // User A -> Contract
            token_a_dispatcher.transfer_from(user_a, get_contract_address(), amount_in_a);
            
            // User B -> Contract  
            token_b_dispatcher.transfer_from(user_b, get_contract_address(), amount_in_b);
            
            // Execute swaps via Ekubo router
            // In production, would integrate with Ekubo's exact router interface
            
            // For MVP: Direct transfer between users
            // Calculate fees
            let protocol_fee = self.protocol_fee_bps.read();
            let fee_a = (amount_in_a * protocol_fee.into()) / 10000;
            let fee_b = (amount_in_b * protocol_fee.into()) / 10000;
            
            // Transfer to users (minus fees)
            token_b_dispatcher.transfer(user_a, amount_in_b - fee_b);
            token_a_dispatcher.transfer(user_b, amount_in_a - fee_a);
            
            // Transfer fees to fee recipient
            if fee_a > 0 {
                token_a_dispatcher.transfer(self.fee_recipient.read(), fee_a);
            }
            if fee_b > 0 {
                token_b_dispatcher.transfer(self.fee_recipient.read(), fee_b);
            }
        }
    }

    // Admin functions
    #[abi(embed_v0)]
    impl DarkPoolAdmin of super::IDarkPoolAdmin<ContractState> {
        fn update_verifier(ref self: ContractState, new_verifier: ContractAddress) {
            self._assert_owner();
            self.verifier_contract.write(new_verifier);
        }

        fn update_fee_recipient(ref self: ContractState, new_recipient: ContractAddress) {
            self._assert_owner();
            self.fee_recipient.write(new_recipient);
        }

        fn update_protocol_fee(ref self: ContractState, new_fee_bps: u16) {
            self._assert_owner();
            assert(new_fee_bps <= 1000, 'Fee too high'); // Max 10%
            self.protocol_fee_bps.write(new_fee_bps);
        }

        fn pause(ref self: ContractState) {
            self._assert_owner();
            // Implement pause logic
        }

        fn unpause(ref self: ContractState) {
            self._assert_owner();
            // Implement unpause logic
        }
    }

    #[generate_trait]
    impl AdminInternal of AdminInternalTrait {
        fn _assert_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'Only owner');
        }
    }
}

#[starknet::interface]
trait IDarkPoolAdmin<TContractState> {
    fn update_verifier(ref self: TContractState, new_verifier: ContractAddress);
    fn update_fee_recipient(ref self: TContractState, new_recipient: ContractAddress);
    fn update_protocol_fee(ref self: TContractState, new_fee_bps: u16);
    fn pause(ref self: TContractState);
    fn unpause(ref self: TContractState);
}

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
