const { expect } = require('chai');
const axios = require('axios');

describe('StarkShield Solver v1 Integration Tests', function () {
  this.timeout(60000);

  const solverClient = axios.create({
    baseURL: process.env.SOLVER_URL || 'http://localhost:8080',
    timeout: 20000,
  });
  const authClient = axios.create({
    baseURL: process.env.SOLVER_URL || 'http://localhost:8080',
    timeout: 20000,
  });
  let accessToken = '';

  const basePublicInputs = {
    user: '0x1234567890abcdef',
    token_in: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
    token_out: '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8',
    amount_in: '1000000000000000000',
    min_amount_out: '3000000000',
    chain_id: 'SN_SEPOLIA',
    domain_separator: 'starkshield-hackathon',
    version: 1,
  };

  function makeIntentPayload(overrides = {}) {
    const seed = Math.random().toString(16).slice(2);
    return {
      intent_hash: `0x${seed.padEnd(64, '1').slice(0, 64)}`,
      nullifier: `0x${seed.padEnd(64, '2').slice(0, 64)}`,
      proof_data: ['1', '2', '3', '4', '5', '6', '7', '8'],
      public_inputs: {
        ...basePublicInputs,
        nonce: Number(overrides.nonce ?? Date.now()),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        ...(overrides.public_inputs || {}),
      },
      encrypted_details: 'eyJtb2NrIjoidHJ1ZSJ9',
      signature: '0x' + '00'.repeat(64),
      ...overrides,
    };
  }

  before(async () => {
    const response = await solverClient.post('/v1/auth/login', {
      username: process.env.AUTH_USERNAME || 'admin',
      password: process.env.AUTH_PASSWORD || 'changeme',
    });

    expect(response.status).to.equal(200);
    expect(response.data.token).to.exist;
    accessToken = response.data.token;
    authClient.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
  });

  describe('Authentication', () => {
    it('rejects protected endpoint without token', async () => {
      try {
        await solverClient.get('/v1/intents/pending');
        expect.fail('Expected unauthorized response');
      } catch (error) {
        expect(error.response.status).to.equal(401);
        expect(error.response.data.code).to.equal('UNAUTHORIZED');
      }
    });
  });

  describe('Health Check', () => {
    it('returns healthy status from v1 route', async () => {
      const response = await solverClient.get('/v1/health');
      expect(response.status).to.equal(200);
      expect(response.data.status).to.equal('healthy');
      expect(response.data.version).to.exist;
    });
  });

  describe('Intent Submission', () => {
    it('accepts valid intent payload', async () => {
      const payload = makeIntentPayload();
      const response = await authClient.post('/v1/intents', payload);
      expect(response.status).to.equal(200);
      expect(response.data.intent_id).to.exist;
      expect(response.data.status).to.equal('pending');
      expect(response.data.correlation_id).to.exist;
    });

    it('rejects nonce replay', async () => {
      const nonce = Date.now();
      const user = '0xfeedface01';
      const first = makeIntentPayload({
        public_inputs: { nonce, user },
      });
      const second = makeIntentPayload({
        public_inputs: { nonce, user },
      });

      await authClient.post('/v1/intents', first);

      try {
        await authClient.post('/v1/intents', second);
        expect.fail('Expected replay rejection');
      } catch (error) {
        expect(error.response.status).to.equal(409);
        expect(error.response.data.code).to.equal('ERR_NONCE_REPLAY');
      }
    });

    it('rejects expired intent', async () => {
      const payload = makeIntentPayload({
        public_inputs: {
          deadline: Math.floor(Date.now() / 1000) - 10,
        },
      });

      try {
        await authClient.post('/v1/intents', payload);
        expect.fail('Expected expired intent rejection');
      } catch (error) {
        expect(error.response.status).to.equal(400);
        expect(error.response.data.code).to.equal('ERR_EXPIRED_INTENT');
      }
    });
  });

  describe('Intent Lifecycle', () => {
    it('queries and cancels pending intent', async () => {
      const payload = makeIntentPayload();
      await authClient.post('/v1/intents', payload);

      const query = await authClient.get(`/v1/intents/${payload.nullifier}`);
      expect(query.status).to.equal(200);
      expect(query.data.intent).to.exist;
      expect(query.data.intent.status).to.equal('pending');

      const cancel = await authClient.post(`/v1/intents/${payload.nullifier}/cancel`);
      expect(cancel.status).to.equal(200);
      expect(cancel.data.success).to.equal(true);

      const queryAfter = await authClient.get(`/v1/intents/${payload.nullifier}`);
      expect(queryAfter.data.intent.status).to.equal('cancelled');
    });
  });
});
