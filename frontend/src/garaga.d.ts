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
}
