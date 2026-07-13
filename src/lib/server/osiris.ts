import { env } from '$env/dynamic/private';

export const MINT = () => env.OSIRIS_TOKEN_MINT || '2nZNHm3Lr9umG3DVrzYwHgktwkuKuJRXqqRqs3ewpump';
export const POOL = () => env.OSIRIS_POOL_ADDRESS || 'G3rchnZ2WLsBDZSrVME4fTyzFP57F3yvvqWMxAy2b4ce';
