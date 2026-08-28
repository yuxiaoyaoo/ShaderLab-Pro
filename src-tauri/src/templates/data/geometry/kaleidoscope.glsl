float hash11(float p)
{
    p = fract(p * 127.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
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
    uv *= 1.6;
    uv.y -= iTime * 0.05;

    float ang = atan(uv.y, uv.x);
    float rad = length(uv);

    float seg = 6.2831853 / 8.0;
    float folded = abs(mod(ang + iTime * 0.15, seg) - seg * 0.5);
    vec2 p = vec2(cos(folded), sin(folded)) * rad;

    p *= 2.4;
    float warp = fbm(p * 0.9 + 3.7);
    float rings = fbm(vec2(p.y * 0.8 - iTime * 0.4, p.x * 0.8) + warp * 1.4);

    vec3 palette = 0.5 + 0.5 * cos(6.2831853 * (rings * 1.2 + 0.6 + 0.1 * sin(rad * 3.0 - iTime * 0.5) + vec3(0.0, 0.33, 0.67)));
    float glow = pow(max(rings - 0.25, 0.0) / 0.75, 1.4);
    float vignette = 1.0 - smoothstep(0.5, 1.3, rad);

    fragColor = vec4(palette * glow * vignette, 1.0);
}
