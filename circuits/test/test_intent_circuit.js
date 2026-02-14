const wasm_tester = require("circom_tester").wasm;
const path = require("path");
const assert = require("assert");
const { buildPoseidon } = require("circomlibjs");

describe("Intent Circuit", function () {
    let circuit;
    let poseidon;

    this.timeout(100000);

    before(async () => {
        circuit = await wasm_tester(path.join(__dirname, "..", "intent_circuit.circom"));
        poseidon = await buildPoseidon();
    });

    it("Should verify a valid intent proof", async () => {
        // Generate test inputs
        const user = BigInt("0x1234567890abcdef1234567890abcdef12345678");
        const tokenIn = BigInt("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"); // ETH
        const tokenOut = BigInt("0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8"); // USDC
        const amountIn = BigInt("1000000000000000000"); // 1 ETH
        const minAmountOut = BigInt("3000000000"); // 3000 USDC
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
        const salt = BigInt(Math.floor(Math.random() * 1000000));
        const currentTime = BigInt(Math.floor(Date.now() / 1000));

        // Compute intent hash
        const intentHash = poseidon([
            user, tokenIn, tokenOut, amountIn, minAmountOut, deadline, salt
        ]);

        // Compute nullifier
        const nullifier = poseidon([user, salt]);

        // Mock proofs (in production these are real Merkle proofs)
        const balanceProof = [1, 2, 3, 4];
        const approvalProof = [5, 6, 7, 8];

        const input = {
            user: user.toString(),
            tokenIn: tokenIn.toString(),
            tokenOut: tokenOut.toString(),
            amountIn: amountIn.toString(),
            minAmountOut: minAmountOut.toString(),
            deadline: deadline.toString(),
            salt: salt.toString(),
            balanceProof: balanceProof.map(String),
            approvalProof: approvalProof.map(String),
            intentHash: poseidon.F.toString(intentHash),
            nullifier: poseidon.F.toString(nullifier),
            currentTime: currentTime.toString(),
        };

        const witness = await circuit.calculateWitness(input);
        await circuit.checkConstraints(witness);
        await circuit.assertOut(witness, {});
    });

    it("Should reject expired intent", async () => {
        const user = BigInt("0x1234567890abcdef1234567890abcdef12345678");
        const tokenIn = BigInt("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");
        const tokenOut = BigInt("0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8");
        const amountIn = BigInt("1000000000000000000");
        const minAmountOut = BigInt("3000000000");
        const deadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago (expired)
        const salt = BigInt(Math.floor(Math.random() * 1000000));
        const currentTime = BigInt(Math.floor(Date.now() / 1000));

        const intentHash = poseidon([user, tokenIn, tokenOut, amountIn, minAmountOut, deadline, salt]);
        const nullifier = poseidon([user, salt]);

        const input = {
            user: user.toString(),
            tokenIn: tokenIn.toString(),
            tokenOut: tokenOut.toString(),
            amountIn: amountIn.toString(),
            minAmountOut: minAmountOut.toString(),
            deadline: deadline.toString(),
            salt: salt.toString(),
            balanceProof: ["1", "2", "3", "4"],
            approvalProof: ["5", "6", "7", "8"],
            intentHash: poseidon.F.toString(intentHash),
            nullifier: poseidon.F.toString(nullifier),
            currentTime: currentTime.toString(),
        };

        try {
            await circuit.calculateWitness(input);
            assert.fail("Should have thrown error for expired intent");
        } catch (error) {
            assert(error.message.includes("Assert Failed"));
        }
    });

    it("Should reject zero amount", async () => {
        const user = BigInt("0x1234567890abcdef1234567890abcdef12345678");
        const tokenIn = BigInt("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");
        const tokenOut = BigInt("0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8");
        const amountIn = BigInt("0"); // Zero amount
        const minAmountOut = BigInt("3000000000");
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const salt = BigInt(Math.floor(Math.random() * 1000000));
        const currentTime = BigInt(Math.floor(Date.now() / 1000));

        const intentHash = poseidon([user, tokenIn, tokenOut, amountIn, minAmountOut, deadline, salt]);
        const nullifier = poseidon([user, salt]);

        const input = {
            user: user.toString(),
            tokenIn: tokenIn.toString(),
            tokenOut: tokenOut.toString(),
            amountIn: amountIn.toString(),
            minAmountOut: minAmountOut.toString(),
            deadline: deadline.toString(),
            salt: salt.toString(),
            balanceProof: ["1", "2", "3", "4"],
            approvalProof: ["5", "6", "7", "8"],
            intentHash: poseidon.F.toString(intentHash),
            nullifier: poseidon.F.toString(nullifier),
            currentTime: currentTime.toString(),
        };

        try {
            await circuit.calculateWitness(input);
            assert.fail("Should have thrown error for zero amount");
        } catch (error) {
            assert(error.message.includes("Assert Failed"));
        }
    });

    it("Should reject same token pair", async () => {
        const user = BigInt("0x1234567890abcdef1234567890abcdef12345678");
        const tokenIn = BigInt("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");
        const tokenOut = tokenIn; // Same token
        const amountIn = BigInt("1000000000000000000");
        const minAmountOut = BigInt("3000000000");
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const salt = BigInt(Math.floor(Math.random() * 1000000));
        const currentTime = BigInt(Math.floor(Date.now() / 1000));

        const intentHash = poseidon([user, tokenIn, tokenOut, amountIn, minAmountOut, deadline, salt]);
        const nullifier = poseidon([user, salt]);

        const input = {
            user: user.toString(),
            tokenIn: tokenIn.toString(),
            tokenOut: tokenOut.toString(),
            amountIn: amountIn.toString(),
            minAmountOut: minAmountOut.toString(),
            deadline: deadline.toString(),
            salt: salt.toString(),
            balanceProof: ["1", "2", "3", "4"],
            approvalProof: ["5", "6", "7", "8"],
            intentHash: poseidon.F.toString(intentHash),
            nullifier: poseidon.F.toString(nullifier),
            currentTime: currentTime.toString(),
        };

        try {
            await circuit.calculateWitness(input);
            assert.fail("Should have thrown error for same token pair");
        } catch (error) {
            assert(error.message.includes("Assert Failed"));
        }
    });
});