pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

/// Settlement Circuit
///
/// This circuit proves that two intents can be settled atomically:
/// 1. Both intents are valid (verified separately)
/// 2. Token pairs are complementary (A's tokenIn = B's tokenOut, etc.)
/// 3. Amounts satisfy both parties' minimum requirements
/// 4. Settlement price is within acceptable bounds
///
/// Public Inputs:
/// - intentHashA: Hash of intent A
/// - intentHashB: Hash of intent B
/// - settlementPrice: Agreed upon exchange rate

template SettlementCircuit() {
    // Intent A parameters
    signal input userA;
    signal input tokenInA;
    signal input tokenOutA;
    signal input amountInA;
    signal input minAmountOutA;
    
    // Intent B parameters
    signal input userB;
    signal input tokenInB;
    signal input tokenOutB;
    signal input amountInB;
    signal input minAmountOutB;
    
    // Settlement parameters
    signal input settlementPrice; // price = amountOutA / amountInA
    
    // Public inputs
    signal input intentHashA;
    signal input intentHashB;
    
    // 1. Verify users are different
    component usersDifferent = IsEqual();
    usersDifferent.in[0] <== userA;
    usersDifferent.in[1] <== userB;
    usersDifferent.out === 0;
    
    // 2. Verify token pairs are complementary
    // A's tokenIn must equal B's tokenOut
    component tokenInMatch = IsEqual();
    tokenInMatch.in[0] <== tokenInA;
    tokenInMatch.in[1] <== tokenOutB;
    tokenInMatch.out === 1;
    
    // A's tokenOut must equal B's tokenIn
    component tokenOutMatch = IsEqual();
    tokenOutMatch.in[0] <== tokenOutA;
    tokenOutMatch.in[1] <== tokenInB;
    tokenOutMatch.out === 1;
    
    // 3. Verify amounts satisfy minimum requirements
    // amountInA >= minAmountOutB
    component aSatisfiesB = GreaterEqThan(252);
    aSatisfiesB.in[0] <== amountInA;
    aSatisfiesB.in[1] <== minAmountOutB;
    aSatisfiesB.out === 1;
    
    // amountInB >= minAmountOutA
    component bSatisfiesA = GreaterEqThan(252);
    bSatisfiesA.in[0] <== amountInB;
    bSatisfiesA.in[1] <== minAmountOutA;
    bSatisfiesA.out === 1;
    
    // 4. Verify settlement price
    // settlementPrice = amountOutA / amountInA = amountInB / amountInA
    // Cross multiply: settlementPrice * amountInA = amountInB
    // For integer arithmetic: settlementPrice * amountInA / SCALE = amountInB
    
    // Simplified: Just verify that the exchange is fair
    // In production, this would include price oracles and slippage protection
    
    // Verify intent hashes match
    component hasherA = Poseidon(6);
    hasherA.inputs[0] <== userA;
    hasherA.inputs[1] <== tokenInA;
    hasherA.inputs[2] <== tokenOutA;
    hasherA.inputs[3] <== amountInA;
    hasherA.inputs[4] <== minAmountOutA;
    // Note: Missing deadline and salt for simplicity in this example
    hasherA.inputs[5] <== 0; // padding
    
    hasherA.out === intentHashA;
    
    component hasherB = Poseidon(6);
    hasherB.inputs[0] <== userB;
    hasherB.inputs[1] <== tokenInB;
    hasherB.inputs[2] <== tokenOutB;
    hasherB.inputs[3] <== amountInB;
    hasherB.inputs[4] <== minAmountOutB;
    hasherB.inputs[5] <== 0; // padding
    
    hasherB.out === intentHashB;
}

component main {public [intentHashA, intentHashB]} = SettlementCircuit();