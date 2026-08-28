float hash21(vec2 p)
{
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

float noise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++)
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

    float heightFade = 1.0 - smoothstep(-0.55, 0.65, uv.y);

    vec2 warpIn = vec2(uv.x * 1.4, -iTime * 1.8);
    float warp = fbm(warpIn);

    vec2 fieldP = vec2(uv.x * 2.5, uv.y * 1.8 - iTime * 2.6) + warp * 0.9;
    float turb = fbm(fieldP);

    float intensity = clamp(heightFade * (turb * 2.1 - 0.35), 0.0, 1.0);

    vec3 outerC = vec3(0.55, 0.06, 0.01);
    vec3 midC = vec3(1.00, 0.35, 0.05);
    vec3 coreC = vec3(1.00, 0.86, 0.40);

    vec3 col = mix(outerC, midC, smoothstep(0.18, 0.62, intensity));
    col = mix(col, coreC, smoothstep(0.62, 0.95, intensity));

    col *= 0.9 + 0.35 * turb;
    col *= 1.0 - 0.30 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}
