export declare const sizingVariablesDeclaration = "\nin vec2 v_objectUV;\nin vec2 v_responsiveUV;\nin vec2 v_responsiveBoxGivenSize;\nin vec2 v_patternUV;\nin vec2 v_imageUV;";
export declare const sizingDebugVariablesDeclaration = "\nin vec2 v_objectBoxSize;\nin vec2 v_objectHelperBox;\nin vec2 v_responsiveBoxSize;\nin vec2 v_responsiveHelperBox;\nin vec2 v_patternBoxSize;\nin vec2 v_patternHelperBox;";
export declare const sizingUniformsDeclaration = "\nuniform float u_originX;\nuniform float u_originY;\nuniform float u_worldWidth;\nuniform float u_worldHeight;\nuniform float u_fit;\n\nuniform float u_scale;\nuniform float u_rotation;\nuniform float u_offsetX;\nuniform float u_offsetY;";
export interface ShaderSizingUniforms {
    u_fit: (typeof ShaderFitOptions)[ShaderFit];
    u_scale: number;
    u_rotation: number;
    u_originX: number;
    u_originY: number;
    u_offsetX: number;
    u_offsetY: number;
    u_worldWidth: number;
    u_worldHeight: number;
}
export interface ShaderSizingParams {
    fit?: 'none' | 'contain' | 'cover';
    scale?: number;
    rotation?: number;
    originX?: number;
    originY?: number;
    offsetX?: number;
    offsetY?: number;
    worldWidth?: number;
    worldHeight?: number;
}
export declare const defaultObjectSizing: Required<ShaderSizingParams>;
export declare const defaultPatternSizing: Required<ShaderSizingParams>;
export declare const ShaderFitOptions: {
    readonly none: 0;
    readonly contain: 1;
    readonly cover: 2;
};
export type ShaderFit = keyof typeof ShaderFitOptions;
