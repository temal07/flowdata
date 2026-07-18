export type Kind = "function" |
    "param" |
    "class" |
    "variable" |
    "type" |
    "conditional" |
    "catch" |
    "import" 
;


export interface Binding {
    source?: string;
    name: string;
    line: number;
    varType: string;
    file: string;
    kind: Kind;
    params?: Binding[];
    start: number;
    role: "declaration" | "use";
    uses: Use[];
}

export interface Use {
    name: string;
    file: string;
    line: number;
    start: number;
    feeds?: { name: string; file: string; line: number; start: number; };
}

export type Scope = {
    name: string;
    declarations: Binding[];
    savedFeedTarget: Binding | null;
}

export interface Results {
    declarations: Binding[];
}