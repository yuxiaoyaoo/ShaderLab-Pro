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
    for (int i = 0; i < 4; i++)
    {
        v += a * noise(p);
        p = r * p * 2.03;
        a *= 0.5;
    }
    return v;
}

float waveHeight(vec2 p)
{
    float t = iTime * 0.7;
    float h = sin(dot(p, vec2(1.3, 0.8)) + t * 2.1) * 0.28;
    h += sin(dot(p, vec2(-0.9, 1.6)) + t * 1.7) * 0.22;
    h += fbm(p * 1.7 + vec2(t * 0.55, -t * 0.4)) * 0.9;
    return h;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec2 p = uv * 3.2;

    float e = 0.03;
    float hL = waveHeight(p - vec2(e, 0.0));
    float hR = waveHeight(p + vec2(e, 0.0));
    float hD = waveHeight(p - vec2(0.0, e));
    float hU = waveHeight(p + vec2(0.0, e));

    float strength = 2.4;
    vec3 n = normalize(vec3((hL - hR) * strength, (hD - hU) * strength, 1.0));

    vec3 viewDir = normalize(vec3(uv * 0.6 + vec2(0.0, 0.9), 1.0));
    vec3 reflDir = reflect(viewDir, n);

    vec3 deepWater = vec3(0.02, 0.10, 0.16) * (0.7 + 0.3 * n.z);
    vec3 skyRefl = mix(vec3(0.90, 0.65, 0.35), vec3(0.25, 0.45, 0.75), clamp(reflDir.y * 1.4, 0.0, 1.0));

    float fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
    float tiltBias = 0.45 + 0.60 * clamp(uv.y + 0.5, 0.0, 1.0);
    float reflMix = clamp(fres * tiltBias + 0.12, 0.0, 1.0);

    vec3 col = mix(deepWater, skyRefl, reflMix);

    vec3 sunDir = normalize(vec3(0.35, 0.75, 0.55));
    float glint = pow(max(dot(reflDir, sunDir), 0.0), 220.0);
    col += vec3(1.0, 0.9, 0.7) * glint * 2.0;

    fragColor = vec4(col, 1.0);
}
