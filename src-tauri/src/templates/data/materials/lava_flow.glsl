float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
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
    vec2 p = uv * 2.6;

    float t = iTime * 0.12;
    vec2 drift = vec2(-t * 1.6, t * 0.35);

    vec2 q = vec2(fbm(p + drift),
                  fbm(p + vec2(5.2, 1.3) - drift.yx));
    vec2 r = vec2(fbm(p + q * 1.8 + vec2(1.7, 9.2) + drift * 0.7),
                  fbm(p + q * 1.8 + vec2(8.3, 2.8) - drift * 0.5));
    float h = fbm(p + r * 2.0);

    float crust = smoothstep(0.32, 0.55, h);
    float veins = pow(clamp(1.0 - abs(h - 0.42) * 7.0, 0.0, 1.0), 2.2);

    vec3 rock = mix(vec3(0.05, 0.04, 0.04), vec3(0.16, 0.13, 0.12), crust);
    rock *= 0.6 + 0.8 * r.x;

    vec3 hot = mix(vec3(0.90, 0.15, 0.02), vec3(1.00, 0.85, 0.25), veins);
    float glowK = pow(clamp((0.55 - h) * 2.6, 0.0, 1.0), 1.6);

    vec3 col = mix(hot, rock, crust);
    col += hot * glowK * 0.55;

    col *= 1.0 - 0.28 * dot(uv, uv);
    fragColor = vec4(col, 1.0);
}
