export type Kind = "function" |
    "param" |
    "class" |
    "variable" |
    "type" |
    "conditional" |
    "catch";

export interface Binding {
    name: string;
    line: number;
    varType: string;
    file: string;
    kind: Kind;
    start: number;
    role: "declaration" | "use";
    uses: Binding[]
}

export type Scope = {
    name: string;
    declarations: Binding[];
}

export interface Results {
    uses: Binding[];
    declarations: Binding[];
}