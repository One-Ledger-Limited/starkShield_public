declare module 'garaga' {
  export enum CurveId {
    BN254 = 0,
  }

  export function init(): Promise<void>;
  export function getGroth16CallData(
    proof: unknown,
    vk: unknown,
    curveId: CurveId,
  ): Promise<Array<bigint | string | number>>;
  export function get_groth16_calldata(
    proof_js: unknown,
    vk_js: unknown,
    curve_id_js: unknown,
  ): Array<bigint | string | number>;
}
