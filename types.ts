export type Kind = "function" |
    "param" |
    "class" |
    "variable" |
    "type" |
    "use" |
    "catch";

// the Binding interface defines the use or declaration of a variable

export interface Binding {
    name: string;
    line: number;
    varType: string;
    file: string;
    kind: Kind;
    
}