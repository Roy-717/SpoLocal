import type { ShaderMotionParams } from '../shader-mount.js';
import { type ShaderSizingParams, type ShaderSizingUniforms } from '../shader-sizing.js';
/**
 * Animated 2-color dithering over multiple pattern sources (noise, warp, dots, waves, ripple, swirl, sphere).
 * Great for retro, print-like, or stylized UI textures.
 *
 * Note: pixelization is applied to the shapes BEFORE dithering, meaning pixels don't react to scaling and fit
 *
 * Fragment shader uniforms:
 * - u_time (float): Animation time
 * - u_resolution (vec2): Canvas resolution in pixels
 * - u_pixelRatio (float): Device pixel ratio
 * - u_colorBack (vec4): Background color in RGBA
 * - u_colorFront (vec4): Foreground (ink) color in RGBA
 * - u_shape (float): Shape pattern type (1 = simplex, 2 = warp, 3 = dots, 4 = wave, 5 = ripple, 6 = swirl, 7 = sphere)
 * - u_type (float): Dithering type (1 = random, 2 = 2x2 Bayer, 3 = 4x4 Bayer, 4 = 8x8 Bayer)
 * - u_pxSize (float; duplicate, not currently used)
 *
 * */
export declare const ditheringFragmentShader: string;
export interface DitheringUniforms extends ShaderSizingUniforms {
    u_colorBack: [number, number, number, number];
    u_colorFront: [number, number, number, number];
    u_shape: (typeof DitheringShapes)[DitheringShape];
    u_type: (typeof DitheringTypes)[DitheringType];
    u_pxSize: number;
}
export interface DitheringParams extends ShaderSizingParams, ShaderMotionParams {
    colorBack?: string;
    colorFront?: string;
    shape?: DitheringShape;
    type?: DitheringType;
    size?: number;
}
export declare const DitheringShapes: {
    readonly simplex: 1;
    readonly warp: 2;
    readonly dots: 3;
    readonly wave: 4;
    readonly ripple: 5;
    readonly swirl: 6;
    readonly sphere: 7;
};
export type DitheringShape = keyof typeof DitheringShapes;
export declare const DitheringTypes: {
    readonly random: 1;
    readonly '2x2': 2;
    readonly '4x4': 3;
    readonly '8x8': 4;
};
export type DitheringType = keyof typeof DitheringTypes;
