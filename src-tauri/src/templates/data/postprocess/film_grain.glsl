float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

vec3 scenePlate(vec2 uv)
{
    vec3 col = mix(vec3(0.045, 0.05, 0.065), vec3(0.10, 0.10, 0.125), uv.y * 0.5 + 0.5);

    vec2 lp = 0.5 * vec2(sin(iTime * 0.5), cos(iTime * 0.83)) + vec2(sin(iTime * 0.31) * 0.18, 0.0);
    float dl = length(uv - lp);
    col += vec3(0.9, 0.62, 0.34) * exp(-dl * dl * 7.5) * 0.6;

    float beam = pow(max(sin((uv.x + uv.y) * 5.5 - iTime * 1.1), 0.0), 10.0);
    col += vec3(0.35, 0.4, 0.55) * beam * 0.10;

    float glowDot = length(uv - vec2(cos(iTime * 0.4) * 0.55, -sin(iTime * 0.6) * 0.28));
    col += vec3(0.4, 0.65, 0.9) * exp(-glowDot * glowDot * 26.0) * 0.35;

    return col;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec2 weave = vec2(sin(iTime * 3.1) * 0.0009, cos(iTime * 2.3) * 0.0007);
    vec3 base = scenePlate(uv + weave);

    float lum = dot(base, vec3(0.299, 0.587, 0.114));

    vec2 gp = fragCoord.xy * 0.5 + vec2(iTime * 61.7, iTime * 47.3);
    float gn = hash21(gp);
    float gr = hash21(gp + 13.7);
    float gb = hash21(gp + 27.1);

    float amp = 0.06 + 0.11 * (1.0 - lum);
    vec3 grain = mix(vec3(gn), vec3(gr, gn, gb), 0.22);

    vec3 col = base * (1.0 + (grain - 0.5) * amp) + (grain - 0.5) * 0.012;

    float frameBucket = floor(iTime * 24.0);
    float flicker = 0.985 + 0.01 * sin(iTime * 11.3) + 0.014 * (hash21(vec2(frameBucket, 3.0)) - 0.5);
    col *= flicker;

    col = max(col - 0.011, 0.0) + vec3(0.011, 0.0098, 0.0088);
    col *= 1.0 - 0.5 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}
