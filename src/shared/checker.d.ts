declare module '*.mjs' {
  export function checkEvidence(input:unknown): {
    result:'passed'|'failed'|'invalid_input'; assertions:{total:number;passed:number;failed:number};
    failures:Array<{code:string;effectIndex?:number;eventIndex?:number}>;
  };
}
