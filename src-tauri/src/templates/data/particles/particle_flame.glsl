float hash11(float p)
{
    p = fract(p * 443.897541);
    p *= p + p + 19.19;
    return fract(p * p);
}

float noise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash11(i.x + i.y * 57.0);
    float b = hash11(i.x + 1.0 + i.y * 57.0);
    float c = hash11(i.x + (i.y + 1.0) * 57.0);
    float d = hash11(i.x + 1.0 + (i.y + 1.0) * 57.0);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++)
    {
        v += a * noise(p);
        p = r * p * 2.03;
        a *= 0.5;
    }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    uv.y += 0.28;

    vec2 q = uv * 4.0;
    q.y -= iTime * 3.0;
    float n = fbm(q * 1.6);

    float width = max(0.02, 0.20 * (1.0 - uv.y * 0.75));
    float g = uv.x / (width + n * 0.16);
    float core = exp(-g * g * 2.0) * (1.0 - smoothstep(-0.20, 0.45, uv.y));
    core *= 0.8 + 0.8 * n;

    float heat = clamp(core * 1.6, 0.0, 1.0);

    vec3 col = vec3(0.015, 0.005, 0.005);
    col += vec3(1.0, 0.32, 0.05) * pow(heat, 1.8);
    col += vec3(1.0, 0.85, 0.45) * pow(heat, 5.0);

    for (int i = 0; i < 24; i++)
    {
        float fi = float(i);
        float sp = hash11(fi * 7.31 + 1.7);
        float sy = hash11(fi * 3.77 + 9.1);
        float y = fract(iTime * (0.35 + 0.55 * sp) + sy) * 1.25 - 0.18;
        float wob = 0.14 * sin(y * 8.0 + sp * 37.0) + (sy - 0.5) * 0.2;
        vec2 pos = vec2(wob, y);
        float d = length(uv - pos);
        float fade = smoothstep(-0.05, 0.25, y) * (1.0 - smoothstep(0.35, 1.05, y));
        float s = 1.0 - smoothstep(0.0, 0.018 + 0.01 * sp, d);
        col += vec3(1.0, 0.55, 0.18) * s * fade * sp;
    }

    fragColor = vec4(col, 1.0);
}
