/** Tipos mínimos de soundtouchjs (el paquete no trae declaraciones). */
declare module "soundtouchjs" {
  export class FifoSampleBuffer {
    readonly frameCount: number;
    putSamples(muestras: Float32Array, posicion?: number, frames?: number): void;
    receiveSamples(salida: Float32Array, frames?: number): void;
    clear(): void;
  }
  export class SoundTouch {
    tempo: number;
    rate: number;
    pitch: number;
    pitchSemitones: number;
    readonly inputBuffer: FifoSampleBuffer;
    readonly outputBuffer: FifoSampleBuffer;
    process(): void;
    clear(): void;
  }
}
