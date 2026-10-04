/** 测试辅助：与 mock-comfy.js 一致的最小节点 schema 集（供表单推导单测使用）。 */

export function createMockSchemas() {
  return {
    KSampler: {
      input: {
        required: {
          model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
          seed: ['INT', { default: 0, min: 0, max: 1125899906842624 }],
          steps: ['INT', { default: 20, min: 1, max: 10000 }],
          cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
          sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim']],
          scheduler: [['normal', 'karras', 'simple']],
          denoise: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }],
        },
      },
    },
    KSamplerAdvanced: {
      input: {
        required: {
          model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
          add_noise: [['enable', 'disable']],
          noise_seed: ['INT', { default: 0, min: 0, max: 1125899906842624 }],
          steps: ['INT', { default: 20, min: 1, max: 10000 }],
          cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
          sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim']],
          scheduler: [['normal', 'karras', 'simple']],
          start_at_step: ['INT', { default: 0, min: 0, max: 10000 }],
          end_at_step: ['INT', { default: 10000, min: 0, max: 10000 }],
          return_with_leftover_noise: [['disable', 'enable']],
        },
      },
    },
    CLIPTextEncode: {
      input: { required: { text: ['STRING', { multiline: true, default: '' }], clip: ['CLIP'] } },
    },
    EmptyLatentImage: {
      input: {
        required: {
          width: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
          height: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
          batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
        },
      },
    },
    EmptySD3LatentImage: {
      input: {
        required: {
          width: ['INT', { default: 1024, min: 16, max: 16384, step: 8 }],
          height: ['INT', { default: 1024, min: 16, max: 16384, step: 8 }],
          batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
        },
      },
    },
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [['mock_a.safetensors', 'mock_b.safetensors']] } },
    },
    VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
    SaveImage: {
      input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } },
    },
  };
}
